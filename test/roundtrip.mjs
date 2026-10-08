/**
 * dsh-undo 业务逻辑自测：手写 mock 的 fs/tools/agent 服务，跑完整快照与回滚流程。
 *
 * 运行：npm test        （等价于 node test/roundtrip.mjs）
 *
 * 覆盖重点（v0.2 起）：轮次分组 —— 一条用户消息改动的所有文件能一次回退，
 * 而不是只能退单个文件；同时保留单文件回退与 dry-run 预演。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = join(ROOT, '.test-home');       // 隔离的 DSH_HOME
const WORK = join(ROOT, '.test-work');       // 隔离的工作目录

process.env.DSH_HOME = HOME;
rmSync(HOME, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(WORK, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

/**
 * 假会话：插件用「最近一条 user/message 的 seq」当作轮次边界，这里就按这个
 * 契约造一个最小可用的会话日志。startTurn() 模拟用户发来一条新消息。
 */
const SESSION = {
  id: 'session-test',
  seq: 0,
  events: [],
  startTurn(text) {
    this.seq += 1;
    this.events.push({ type: 'user/message', seq: this.seq, data: { text } });
    this.seq += 1; // 模型开始回应（step/assistant 事件）
    return String(this.seq - 1);
  },
  snapshotEvents(from = 0, to = this.seq) {
    return this.events.filter((event) => event.seq >= from && event.seq < to);
  },
};

const STATE = { handlers: {}, tool: undefined };
const mockCtx = {
  fs: {
    processPath: (target) => target.path,
    stat: async (target) => (existsSync(target.path) ? { type: 'file', size: statSync(target.path).size } : undefined),
    readText: async (target) => readFileSync(target.path, 'utf8'),
    resolve: async (path) => ({ path }),
    // 忠实模拟真实 fs 服务：writeText 落盘之前必定触发 fs/write-intent。
    // 真实实现里 actor 来自异步上下文中的工具执行；这里用合成 actor 代替。
    writeText: async (target, content) => {
      for (const handler of STATE.handlers['fs/write-intent'] ?? []) {
        await handler(target, { callId: 'undo-restore' }, async () => undefined);
      }
      writeFileSync(target.path, content);
      return {};
    },
  },
  tools: { register: (definition) => { STATE.tool = definition; return () => {}; } },
  on: (event, handler) => { (STATE.handlers[event] ??= []).push(handler); },
};

console.log('=== 0. 加载与注册 ===');
const mod = await import('../lib/index.js');
mod.apply(mockCtx, {
  maxSnapshots: 40,
  maxFileBytes: 1024 * 1024,
  onlyToolWrites: false,
  sessionScanEvents: 400,
  listFilesPerTurn: 5,
  debug: false,
});
check('导出了 name/apply/inject/Config', ['name', 'apply', 'inject', 'Config'].every((key) => mod[key] !== undefined));
check('注册了 fs/write-intent 钩子', (STATE.handlers['fs/write-intent'] ?? []).length === 1);
check('注册了 fs/edit-intent 钩子', (STATE.handlers['fs/edit-intent'] ?? []).length === 1);
check('注册了 undo 工具', STATE.tool !== undefined && STATE.tool.name === 'undo');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('package.json 声明了 dsh.bundle（dsh plugin add 据此安装）', manifest?.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(manifest?.dsh));
check('仓库根的 cordis.patch.yml 挂载本插件', readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8').includes('@ruaibeite/dsh-undo'));
check('描述里不含营销词（收录要求：只说功能）', !/best|最强|革命|完美|amazing|revolutionary/i.test(manifest.description ?? ''));

const indexFile = join(HOME, 'undo', 'index.json');
const readIdx = () => JSON.parse(readFileSync(indexFile, 'utf8'));
/** 触发一次 intent 钩子，actor 带上假会话（真实工具调用就是这样的上下文）。 */
const fire = async (event, path, callId, session = SESSION) =>
  STATE.handlers[event][0]({ path }, { callId, rootCallId: callId, agent: { session } }, async () => 'NEXT_CALLED');
const runTool = async (args) =>
  STATE.tool.execute(args, { signal: undefined, agent: { session: { header: { cwd: WORK }, ...SESSION } } });

console.log('\n=== 1. 第 1 轮：快照并记录轮次 ===');
const turn1 = SESSION.startTurn('第一轮：改 demo.txt');
const demo = join(WORK, 'demo.txt');
writeFileSync(demo, '版本1：原始内容\n');
const nextResult = await fire('fs/edit-intent', demo, 'call-1');
check('钩子把决策权交还原流程（next() 被调用）', nextResult === 'NEXT_CALLED');
check('生成了快照索引', existsSync(indexFile));
let idx = readIdx();
check('快照条目数为 1', idx.length === 1, `实际 ${idx.length}`);
check('记录了 existed=true 与字节数', idx[0]?.existed === true && idx[0]?.bytes > 0);
check('快照内容 = 改动前内容', readFileSync(idx[0].file, 'utf8') === '版本1：原始内容\n');
check('快照带上了轮次与会话 id', idx[0]?.turn === turn1 && idx[0]?.sessionId === 'session-test', `turn=${idx[0]?.turn} session=${idx[0]?.sessionId}`);

console.log('\n=== 2. 第 2 轮：一条消息动了 3 个文件（含同一文件改两次）===');
const turn2 = SESSION.startTurn('第二轮：大改一通');
writeFileSync(demo, '版本2：改坏了\n');
await fire('fs/edit-intent', demo, 'call-2a');                 // demo: 版本2 → 将变版本3
writeFileSync(demo, '版本3：又改一次\n');
await fire('fs/edit-intent', demo, 'call-2b');                 // demo 的第二次快照
const fresh = join(WORK, 'brand-new.txt');
await fire('fs/write-intent', fresh, 'call-2c');               // 新建（快照时文件不存在）
writeFileSync(fresh, '本轮新建的文件\n');
const other = join(WORK, 'other.txt');
writeFileSync(other, '另一个文件的原始内容\n');
await fire('fs/edit-intent', other, 'call-2d');
writeFileSync(other, '另一个文件被改了\n');

idx = readIdx();
const turn2Entries = idx.filter((entry) => entry.turn === turn2);
check('第 2 轮的快照都归到同一轮次', turn2Entries.length === 4, `实际 ${turn2Entries.length}`);
check('第 1 轮的快照未被混入', idx.filter((entry) => entry.turn === turn1).length === 1);

console.log('\n=== 3. list：按轮次分组显示 ===');
const list = await runTool({ action: 'list' });
check('list 返回 ok', list.ok === true);
check('list 显示 2 轮', list.message.includes('共 2 轮'), list.message.split('\n')[0]);
check('list 列出第 2 轮的 3 个文件', list.message.includes('3 个文件'), list.message);
check('list 里有三个路径', ['demo.txt', 'brand-new.txt', 'other.txt'].every((p) => list.message.includes(p)));
console.log('  ── list 输出 ──');
console.log(list.message.split('\n').map((line) => '     ' + line).join('\n'));

console.log('\n=== 4. dry-run：只看不改 ===');
const beforeDry = { demo: readFileSync(demo, 'utf8'), other: readFileSync(other, 'utf8'), freshExists: existsSync(fresh) };
const dry = await runTool({ action: 'restore', dryRun: true });
check('dry-run 返回 ok', dry.ok === true, dry.message);
check('dry-run 报告将删除新建文件', dry.message.includes('将删除') && dry.message.includes('brand-new.txt'), dry.message);
check('dry-run 报告将写入既有文件', dry.message.includes('将写入'), dry.message);
check('dry-run 没有改动任何文件', readFileSync(demo, 'utf8') === beforeDry.demo && existsSync(fresh) === beforeDry.freshExists);

console.log('\n=== 5. 整轮回退：默认回退最近一轮的全部文件 ===');
const restoreTurn = await runTool({ action: 'restore' });
check('整轮回退返回 ok', restoreTurn.ok === true, restoreTurn.message);
check('demo.txt 回到本轮开始前的内容（最早快照胜出）', readFileSync(demo, 'utf8') === '版本2：改坏了\n', JSON.stringify(readFileSync(demo, 'utf8')));
check('other.txt 回到本轮开始前的内容', readFileSync(other, 'utf8') === '另一个文件的原始内容\n', JSON.stringify(readFileSync(other, 'utf8')));
check('本轮新建的文件被删除', !existsSync(fresh));
check('报告里统计了写入与删除', /\d+ 个/.test(restoreTurn.message), restoreTurn.message.split('\n')[0]);

console.log('\n=== 6. 按序号回退更早的一轮（turn "2" = 第 1 轮）===');
// 回退动作本身也会写文件 → 也会被快照，所以「最新一轮」始终是当前轮。
const back = await runTool({ action: 'restore', turn: '2' });
check('按序号回退返回 ok', back.ok === true, back.message);
check('demo.txt 回到第 1 轮开始前的内容', readFileSync(demo, 'utf8') === '版本1：原始内容\n', JSON.stringify(readFileSync(demo, 'utf8')));

console.log('\n=== 7. 单文件回退（按 id）仍然可用 ===');
const single = readIdx().find((entry) => entry.path === other && entry.existed);
const restoreOne = await runTool({ action: 'restore', id: single.id });
check('按 id 回退返回 ok', restoreOne.ok === true, restoreOne.message);
check('只影响该 id 对应的文件', readFileSync(other, 'utf8') === '另一个文件的原始内容\n');

console.log('\n=== 8. 容错与边界 ===');
const badAction = await runTool({ action: 'nope' });
check('未知 action 返回 ok=false 且不抛异常', badAction.ok === false);
const badId = await runTool({ action: 'restore', id: '不存在的id' });
check('不存在的 id 返回 ok=false', badId.ok === false, badId.message);
const badTurn = await runTool({ action: 'restore', turn: '99' });
check('越界的轮次序号返回 ok=false', badTurn.ok === false, badTurn.message);
const before = readIdx().length;
const noActor = join(WORK, 'no-actor.txt');
writeFileSync(noActor, '内容\n');
await STATE.handlers['fs/write-intent'][0]({ path: noActor }, undefined, async () => 'NEXT_CALLED');
check('actor 缺失时仍然快照（默认全捕获）', readIdx().length === before + 1, `${before} → ${readIdx().length}`);
const insideHome = join(HOME, 'harness-state.json');
writeFileSync(insideHome, '{}\n');
const beforeHome = readIdx().length;
await STATE.handlers['fs/write-intent'][0]({ path: insideHome }, { callId: 'x' }, async () => 'NEXT_CALLED');
check('$DSH_HOME 内的写入被排除', readIdx().length === beforeHome, `${beforeHome} → ${readIdx().length}`);

console.log('\n=== 9. 容量上限（maxSnapshots=40）===');
for (let i = 0; i < 45; i++) {
  const bulk = join(WORK, `bulk-${i}.txt`);
  writeFileSync(bulk, `内容 ${i}\n`);
  await fire('fs/write-intent', bulk, `bulk-${i}`);
}
check('快照数被限制在 maxSnapshots=40', readIdx().length === 40, `实际 ${readIdx().length}`);

console.log('\n=== 10. list 的输出上限（一次真实调用曾打印 141 个路径）===');
const bulkList = await runTool({ action: 'list', limit: 3 });
const detailLines = bulkList.message.split('\n').filter((line) => /^ {6}\S/.test(line) && !line.includes('…还有'));
check('默认每轮只列 listFilesPerTurn=5 条', detailLines.length <= 15, `实际 ${detailLines.length} 条`);
check('其余文件用省略行汇总', bulkList.message.includes('…还有'), bulkList.message.split('\n').find((l) => l.includes('…还有')) ?? '(无)');
const oneTurn = await runTool({ action: 'list', turn: '1' });
check('list + turn 给出该轮全量清单（不再省略）', oneTurn.ok === true && oneTurn.message.includes('第 1 轮') && !oneTurn.message.includes('…还有'), oneTurn.message.split('\n')[0]);

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
rmSync(HOME, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
