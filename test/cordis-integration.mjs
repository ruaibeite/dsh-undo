/**
 * dsh-undo 真实 cordis 容器集成测试。
 *
 * 与 roundtrip.mjs（手写 mock 容器）的区别：本测试用**真的 cordis Context**、
 * 真的 waterfall 事件分发、真的 Config schema 校验，只把 fs/tools 两个服务换成
 * 假的。它验证的是「接入方式对不对」，而不是「业务逻辑对不对」。
 *
 * 运行：npm run test:integration
 * （官方包由 devDependencies 提供，不再依赖某个已安装的 profile。）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';

const HERE = dirname(dirname(fileURLToPath(import.meta.url))); // 插件根目录
const HOME = join(HERE, '.cordis-test-home');
const WORK = join(HERE, '.cordis-test-work');
process.env.DSH_HOME = HOME;
rmSync(HOME, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(WORK, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

/** 假会话：轮次边界取自「最近一条 user/message 的 seq」，与真实会话同一契约。 */
const session = {
  id: 'cordis-session',
  seq: 0,
  events: [],
  startTurn() {
    this.seq += 1;
    this.events.push({ type: 'user/message', seq: this.seq, data: {} });
    this.seq += 1;
    return String(this.seq - 1);
  },
  snapshotEvents(from = 0, to = this.seq) {
    return this.events.filter((event) => event.seq >= from && event.seq < to);
  },
};

/** 假的 fs 服务：只实现插件用到的方法。 */
class FakeFs extends Service {
  constructor(ctx) {
    super(ctx, 'fs');
  }
  processPath(target) { return target.path; }
  async stat(target) { return existsSync(target.path) ? { type: 'file', size: statSync(target.path).size } : undefined; }
  async readText(target) { return readFileSync(target.path, 'utf8'); }
  async resolve(path) { return { path }; }
  async writeText(target, content) { writeFileSync(target.path, content); return { version: 'v' }; }
}

/** 假的 tools 服务：只记录注册进来的工具。 */
class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.registered = [];
  }
  register(definition) {
    this.registered.push(definition);
    return () => {};
  }
}

console.log('=== 0. 在真实 cordis 容器里加载插件 ===');
const root = new Context();
new FakeFs(root);
const tools = new FakeTools(root);

const mod = await import('../lib/index.js');
let loadError = null;
const fiber = root.plugin(mod, {
  maxSnapshots: 20,
  maxFileBytes: 1024 * 1024,
  onlyToolWrites: false,
  sessionScanEvents: 400,
  debug: false,
});
try {
  await fiber;
} catch (error) {
  loadError = error;
}
check('插件在真实容器里加载成功（含 Config schema 校验）', loadError === null, loadError ? String(loadError.message) : '');
check('undo 工具注册到了 tools 服务', tools.registered.some((tool) => tool.name === 'undo'), `已注册: ${tools.registered.map((tool) => tool.name).join(',') || '无'}`);
check('插件 apply 时创建了快照目录', existsSync(join(HOME, 'undo', 'files')), join(HOME, 'undo', 'files'));

console.log('\n=== 1. 真实 waterfall 事件分发（第 1 轮）===');
const turn1 = session.startTurn();
const demo = join(WORK, 'demo.txt');
writeFileSync(demo, '真实容器里的原始内容\n');
const target = { path: demo };
const actor = { callId: 'cordis-call-1', rootCallId: 'cordis-call-1', agent: { session } };

let bareCalled = false;
const outcome = await root.waterfall('fs/write-intent', target, actor, async () => {
  bareCalled = true;
  return 'BARE_WRITE_RESULT';
});
check('waterfall 把 next 传给了插件处理器（裸写被调用）', bareCalled);
check('插件把决策权原样交还（返回值来自裸写）', outcome === 'BARE_WRITE_RESULT', `实际: ${JSON.stringify(outcome)}`);

const indexFile = join(HOME, 'undo', 'index.json');
check('真实事件分发触发了快照', existsSync(indexFile));
const idx = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
check('快照记录了正确的路径与原内容', idx.length === 1 && idx[0].path === demo && readFileSync(idx[0].file, 'utf8') === '真实容器里的原始内容\n');
check('快照记录了这一轮的轮次与会话', idx[0]?.turn === turn1 && idx[0]?.sessionId === 'cordis-session', `turn=${idx[0]?.turn}`);

console.log('\n=== 2. 第 2 轮：edit-intent 同样生效 ===');
const turn2 = session.startTurn();
writeFileSync(demo, '第二版\n');
await root.waterfall('fs/edit-intent', target, actor, async () => 'BARE');
const afterSecond = JSON.parse(readFileSync(indexFile, 'utf8'));
check('edit-intent 也生成了快照', afterSecond.length === 2, `条目 ${afterSecond.length}`);
check('第 2 轮的快照归到新的轮次', afterSecond.at(-1)?.turn === turn2 && turn2 !== turn1, `turn=${afterSecond.at(-1)?.turn}`);

console.log('\n=== 3. 通过已注册的工具整轮回退 ===');
const undo = tools.registered.find((tool) => tool.name === 'undo');
const exec = { signal: undefined, agent: { session: { header: { cwd: WORK }, ...session } } };
const list = await undo.execute({ action: 'list' }, exec);
check('工具 list 可用且按轮次分组', list.ok === true && list.message.includes('demo.txt') && list.message.includes('共 2 轮'), list.message.split('\n')[0]);

writeFileSync(demo, '被改坏的第三版\n');
const dry = await undo.execute({ action: 'restore', dryRun: true }, exec);
check('dry-run 预演而不写盘', dry.ok === true && readFileSync(demo, 'utf8') === '被改坏的第三版\n', dry.message.split('\n')[0]);

const restored = await undo.execute({ action: 'restore' }, exec);
check('工具整轮回退可用', restored.ok === true, restored.message);
check('文件回到第 2 轮开始前的内容', readFileSync(demo, 'utf8') === '第二版\n', JSON.stringify(readFileSync(demo, 'utf8')));

console.log('\n=== 4. 卸载后钩子失效（验证 effect 生命周期）===');
await fiber.dispose();
const before = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).length : 0;
await root.waterfall('fs/write-intent', target, actor, async () => 'BARE');
const after = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).length : 0;
check('插件卸载后不再产生快照', after === before, `${before} → ${after}`);

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
rmSync(HOME, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
