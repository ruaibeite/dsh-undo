/**
 * 浏览器半边（client half）的结构测试。
 *
 * 不启动浏览器：造一个假的 `window.__ModuleLoader__` 与假的客户端上下文，
 * 执行真正的 `client/client.js`，断言它
 *   ① 按加载器契约注册（id + factory，宿主 require 提供 React）；
 *   ② 往消息动作行 `conversation.chat.assistant-actions` 注册了一个条目；
 *   ③ 该条目按会话注入了 `runUndo`，点击按钮会执行**宿主命令** `/undo 1`
 *      —— 也就是与模型工具、人工 `/undo` 共用同一条执行路径。
 *
 * 运行：npm run test:client
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 1. 加载器契约 ===');
let loaded;
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry; } } };
await import('../client/client.js');
check('用 window.__ModuleLoader__.load 注册', loaded !== undefined);
check('id 是包名', loaded?.id === '@ruaibeite/dsh-undo', String(loaded?.id));
check('factory 是函数', typeof loaded?.factory === 'function');

console.log('\n=== 2. package.json 声明了客户端半边（宿主据此解析入口）===');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('dsh.client.platform = web', manifest?.dsh?.client?.platform === 'web', JSON.stringify(manifest?.dsh?.client));
check('dsh.client.inject 列出了所需客户端包', Array.isArray(manifest?.dsh?.client?.inject)
  && manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots')
  && manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-commands'), JSON.stringify(manifest?.dsh?.client?.inject));
const clientExport = manifest?.exports?.['./client'];
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default;
check('exports["./client"] 是字符串或带字符串 default 的对象', typeof clientPath === 'string', JSON.stringify(clientExport));
check('该入口文件存在', typeof clientPath === 'string' && existsSync(join(ROOT, clientPath)), String(clientPath));

console.log('\n=== 3. 工厂产出客户端插件 ===');
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  Fragment: 'Fragment'
};
const clientModule = loaded.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`unexpected require: ${specifier}`);
});
check('导出 apply / inject / name', ['apply', 'inject', 'name'].every((key) => clientModule[key] !== undefined));
check('只注入 slots 与 commandUi', JSON.stringify(clientModule.inject) === JSON.stringify(['slots', 'commandUi']), JSON.stringify(clientModule.inject));

console.log('\n=== 4. 注册进消息动作行 ===');
const seen = [];
const fakeCtx = {
  slots: {
    inject: (slotName, callback) => { seen.push(['inject', slotName]); callback(); },
    register: (definition, component) => { seen.push(['register', definition, component]); return () => {}; }
  },
  commandUi: {
    execute: (session, line) => { seen.push(['execute', session, line]); return Promise.resolve({ kind: 'success' }); }
  }
};
const clientApply = clientModule.apply;
clientApply(fakeCtx);
const injectCall = seen.find((entry) => entry[0] === 'inject');
const registerCall = seen.find((entry) => entry[0] === 'register');
check('inject 到 conversation.chat.assistant-actions', injectCall?.[1] === 'conversation.chat.assistant-actions', String(injectCall?.[1]));
check('注册条目的 name 与 id 正确', registerCall?.[1]?.name === 'conversation.chat.assistant-actions' && registerCall?.[1]?.id === 'undo-turn', JSON.stringify(registerCall?.[1] && { name: registerCall[1].name, id: registerCall[1].id }));
check('条目带数字 order（排在官方反馈之后）', Number.isInteger(registerCall?.[1]?.order) && registerCall[1].order > 10, String(registerCall?.[1]?.order));
check('注册了组件', typeof registerCall?.[2] === 'function');

console.log('\n=== 5. 按钮点击 → 宿主命令 /undo 1 ===');
const injected = registerCall[1].inject('session-42');
check('按会话注入 runUndo', typeof injected?.runUndo === 'function');
const outcome = await injected.runUndo('/undo 1');
const executeCall = seen.find((entry) => entry[0] === 'execute');
check('执行的是绑定了 sessionId 的 /undo 1', executeCall?.[2] === '/undo 1' && executeCall?.[1]?.sessionId === 'session-42', JSON.stringify(executeCall?.slice(1)));
check('把宿主命令结果原样交回组件', outcome?.kind === 'success', JSON.stringify(outcome));

console.log('\n=== 6. 组件渲染出按钮 ===');
const tree = registerCall[2]({ runUndo: injected.runUndo });
check('渲染成一个 button', tree?.type === 'button', String(tree?.type));
check('按钮有提示文案且提到「回退」', typeof tree?.props?.title === 'string' && tree.props.title.includes('回退'), String(tree?.props?.title));
check('带 aria-label（可访问性）', typeof tree?.props?.['aria-label'] === 'string' && tree.props['aria-label'].length > 0);

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed === 0 ? 0 : 1);
