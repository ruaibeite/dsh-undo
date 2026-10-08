/**
 * @ruaibeite/dsh-undo — 按轮次回退 agent 对文件的修改。
 *
 * 机制：dsh-fs 在真正落盘之前会触发 `fs/write-intent`（writeText）与
 * `fs/edit-intent`（editText）两个 waterfall 决策钩子。本插件在钩子里先把目标
 * 文件的**当前内容**快照到 $DSH_HOME/undo/，再调用 `next()` 把决策权交还原流程
 * —— 只做旁路记录，不改变任何写入语义。
 *
 * 每次快照都记录它属于哪一轮对话（会话日志里最近一条 `user/message` 的 seq），
 * 所以 `undo restore` 能把**一整轮改动过的所有文件**一次退回，而不是只能退单个
 * 文件。回滚动作本身也会被快照，因此回滚可以再撤销。
 *
 * 任何快照失败都被吞掉：撤销功能坏掉不能连带把正常的文件写入弄坏。
 * @module @ruaibeite/dsh-undo
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Stable Loader identity. */
const name = 'tool-undo';

/** Snapshot store tuning. */
const Config = z.object({
  /** How many snapshots to retain before dropping the oldest. */
  maxSnapshots: z.number().default(300),
  /** Files larger than this are not snapshotted (bytes). */
  maxFileBytes: z.number().default(4 * 1024 * 1024),
  /**
   * When true, only writes carrying a tool-execution actor are snapshotted.
   * Default false: every write outside $DSH_HOME is snapshotted, because the
   * real fs pipeline does not always hand the intent hooks an actor.
   */
  onlyToolWrites: z.boolean().default(false),
  /**
   * How many trailing session events to scan for the user message that opened
   * the current turn. Bigger means a more reliable turn boundary on very busy
   * turns, at the cost of copying more of the log per snapshot.
   */
  sessionScanEvents: z.number().default(400),
  /** Append one diagnostic line per intent event to $DSH_HOME/undo/debug.log. */
  debug: z.boolean().default(false),
});

/** Services used by the snapshot hooks and the undo tool. */
const inject = ['fs', 'tools'];

/**
 * Stamp marking an already-wrapped filesystem method, so a second load of this
 * plugin (or a reload of the profile patch) never stacks two wrappers on the
 * same method.
 */
const PATCHED = Symbol.for('@ruaibeite/dsh-undo/patched');

/** Grouping key of the pseudo-turn holding snapshots whose turn could not be read. */
const UNKNOWN_TURN = 'unknown';

/** The harness home ($DSH_HOME, else ~/.dsh). */
function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

/** Root of the snapshot store. */
function storeRoot() {
  return join(dshHome(), 'undo');
}

/** Read the index, tolerating a missing or corrupt file. */
function readIndex(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persist the index, tolerating failure. */
function writeIndex(root, entries) {
  try {
    writeFileSync(join(root, 'index.json'), JSON.stringify(entries, null, 2));
  } catch {
    /* index write failure must not surface */
  }
}

/** Append one diagnostic line when debug logging is on. */
function appendDebug(root, line) {
  try {
    appendFileSync(join(root, 'debug.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* diagnostics must never break a write */
  }
}

/**
 * Read the conversation turn a tool-driven write belongs to.
 *
 * The tool-execution context carries `callId`/`rootCallId`/`agent` but no turn
 * or message id, so the boundary is read from the session log: the seq of the
 * most recent `user/message` event at or before the session's current end.
 * Only the trailing `scanEvents` events are copied, so the cost stays bounded
 * on long sessions.
 *
 * @param actor - the tool-execution context handed to the intent hooks.
 * @param scanEvents - how many trailing session events to inspect.
 * @returns `{ sessionId, turn }`, or undefined when no session is reachable;
 *   `turn` may still be undefined when the log holds no user message yet.
 */
function readTurn(actor, scanEvents) {
  const session = actor !== null && typeof actor === 'object' ? actor.agent?.session : undefined;
  if (session === null || typeof session !== 'object') return undefined;
  const sessionId = typeof session.id === 'string' ? session.id : undefined;
  let turn;
  try {
    if (typeof session.snapshotEvents === 'function') {
      const end = typeof session.seq === 'number' ? session.seq : undefined;
      const events = end === undefined
        ? session.snapshotEvents()
        : session.snapshotEvents(Math.max(0, end - scanEvents), end);
      if (Array.isArray(events)) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (event !== null && typeof event === 'object' && event.type === 'user/message' && event.seq !== undefined) {
            turn = String(event.seq);
            break;
          }
        }
      }
    }
  } catch {
    /* an unreadable session log must not break the write */
  }
  // A write with no user message yet (session title generation, first-step
  // bookkeeping) still belongs somewhere: fall back to the tool call itself.
  if (turn === undefined) {
    const call = actor.rootCallId ?? actor.callId;
    if (call !== undefined) turn = `call:${String(call)}`;
  }
  return { sessionId, turn };
}

/** Grouping key of the turn a snapshot entry belongs to. */
function turnKeyOf(entry) {
  if (entry.turn === undefined || entry.turn === null) {
    return `${entry.sessionId ?? ''}\u0000${UNKNOWN_TURN}`;
  }
  return `${entry.sessionId ?? ''}\u0000${entry.turn}`;
}

/**
 * Group snapshots into conversation turns, oldest turn first.
 * @param entries - index entries in capture order.
 * @returns one record per turn, each holding its entries in capture order.
 */
function groupTurns(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = turnKeyOf(entry);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, sessionId: entry.sessionId, turn: entry.turn, entries: [entry] });
    } else {
      existing.entries.push(entry);
    }
  }
  return [...groups.values()];
}

/**
 * Reduce one turn's snapshots to the state each path had when the turn began.
 *
 * A turn may snapshot the same file several times (two edits in one turn). The
 * earliest snapshot of that path is the pre-turn content, so it wins; the later
 * ones describe intermediate states that no longer matter for a turn rollback.
 *
 * @param entries - the turn's snapshots in capture order.
 * @returns one entry per path, ordered by capture time.
 */
function planTurn(entries) {
  const byPath = new Map();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing === undefined || String(entry.time) < String(existing.time)) byPath.set(entry.path, entry);
  }
  return [...byPath.values()].sort((left, right) => (String(left.time) < String(right.time) ? -1 : 1));
}

/**
 * Pick the turn named by the `turn` argument.
 * @param turns - groups from {@link groupTurns}, oldest first.
 * @param wanted - `"last"`, a 1-based index counted back from the newest turn,
 *   or a raw turn key.
 * @returns the chosen group, or undefined when nothing matches.
 */
function selectTurn(turns, wanted) {
  if (turns.length === 0) return undefined;
  const raw = typeof wanted === 'string' ? wanted.trim() : '';
  if (raw === '' || raw.toLowerCase() === 'last') return turns[turns.length - 1];
  if (/^\d+$/.test(raw)) {
    const back = Number.parseInt(raw, 10);
    if (back >= 1 && back <= turns.length) return turns[turns.length - back];
    return undefined;
  }
  return turns.find((turn) => turn.key === wanted || turn.turn === raw);
}

/**
 * Register undo snapshots and the undo tool.
 * @param ctx - agent-scoped services.
 * @param config - retention and turn-scan limits.
 */
function apply(ctx, config) {
  const root = storeRoot();
  const filesDir = join(root, 'files');
  /**
   * Per-target capture record. Both registrations (plugin scope + root) receive
   * the SAME target object for one waterfall call, so target identity plus a
   * short window de-dupes the pair without suppressing a genuine second write.
   */
  const capturedTargets = new WeakMap();
  /** Per-(event, absolute path) record of the last capture, for cross-mechanism dedupe. */
  const recentByPath = new Map();
  /**
   * Turn cache. Scanning the session log per capture would be wasteful, and the
   * session's `seq` advances on every event, so (session, seq) is an exact
   * cache key: it invalidates the moment anything is appended.
   */
  let turnCache;
  try {
    mkdirSync(filesDir, { recursive: true });
  } catch {
    /* an unwritable store disables snapshots but must not fail the plugin load */
  }
  if (config.debug === true) {
    appendDebug(root, `apply() pid=${process.pid} dshHome=${dshHome()} store=${root} argv="${process.argv.slice(1, 3).join(' ')}"`);
  }

  /** Cached {@link readTurn}. */
  function turnOf(actor) {
    const session = actor !== null && typeof actor === 'object' ? actor.agent?.session : undefined;
    if (session === null || typeof session !== 'object') return readTurn(actor, config.sessionScanEvents);
    const seq = typeof session.seq === 'number' ? session.seq : undefined;
    if (turnCache !== undefined && turnCache.session === session && turnCache.seq === seq) return turnCache.value;
    const value = readTurn(actor, config.sessionScanEvents);
    turnCache = { session, seq, value };
    return value;
  }

  /**
   * Snapshot `target`'s current content before the caller replaces it.
   * @param target - the resolved target about to be written or edited.
   * @param actor - the tool-execution context (undefined for internal writes).
   * @param event - the bare intent event name, used for de-duplication.
   * @param label - which registration delivered the event, for the debug log.
   */
  async function capture(target, actor, event, label) {
    let abs;
    try {
      abs = ctx.fs.processPath(target);
    } catch {
      abs = undefined;
    }
    if (config.debug === true) {
      const keys = actor !== null && typeof actor === 'object'
        ? Object.keys(actor).slice(0, 10).join('|')
        : '-';
      appendDebug(root, `event=${event}@${label} actor=${actor === undefined ? 'undefined' : typeof actor} keys=${keys} path=${abs ?? '<unresolved>'}`);
    }
    if (config.onlyToolWrites === true && actor === undefined) return;
    if (typeof abs !== 'string' || abs.length === 0) return;
    const home = dshHome();
    if (abs === home || abs.startsWith(`${home}/`)) return; // harness state, not a workspace file

    // Cross-mechanism duplicate guard. The intent hook and the service wrapper
    // both observe one logical write, and the sandbox backend hands the wrapper
    // the target returned by `checkedTarget`, which may be a different object
    // than the one the waterfall saw. Only captures from DIFFERENT mechanisms
    // collapse here, so two genuine writes to one path still snapshot twice.
    const stamp = Date.now();
    const pathKey = `${event}\u0000${abs}`;
    const previous = recentByPath.get(pathKey);
    if (recentByPath.size > 4096) recentByPath.clear();
    recentByPath.set(pathKey, { at: stamp, label });
    if (previous !== undefined && previous.label !== label && stamp - previous.at < 250) {
      if (config.debug === true) {
        appendDebug(root, `dedupe-cross ${abs} (${event}: ${previous.label} -> ${label})`);
      }
      return;
    }

    if (target !== null && typeof target === 'object') {
      const now = Date.now();
      const record = capturedTargets.get(target) ?? new Map();
      const last = record.get(event);
      if (last !== undefined && now - last < 250) {
        if (config.debug === true) appendDebug(root, `dedupe-skip ${abs} (${event}@${label})`);
        return;
      }
      record.set(event, now);
      capturedTargets.set(target, record);
    }

    let existed = false;
    let content = '';
    try {
      const info = await ctx.fs.stat(target);
      if (info !== undefined) {
        if (info.type !== 'file') return;
        if (typeof info.size === 'number' && info.size > config.maxFileBytes) return;
        content = await ctx.fs.readText(target);
        if (Buffer.byteLength(content) > config.maxFileBytes) return;
        existed = true;
      }
    } catch {
      return; // unreadable target: record nothing rather than block the write
    }

    const entries = readIndex(root);
    const id = `${String(entries.length + 1).padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
    const file = join(filesDir, id);
    try {
      writeFileSync(file, existed ? content : '');
    } catch {
      return;
    }
    const record = {
      id,
      time: new Date().toISOString(),
      path: abs,
      existed,
      bytes: existed ? Buffer.byteLength(content) : 0,
      file,
    };
    const callId = actor !== undefined ? actor.callId : undefined;
    if (callId !== undefined) record.callId = String(callId);
    const turn = turnOf(actor);
    if (turn !== undefined) {
      if (turn.sessionId !== undefined) record.sessionId = turn.sessionId;
      if (turn.turn !== undefined) record.turn = turn.turn;
    }
    if (record.turn === undefined) {
      // A capture taken through the fs-service fallback carries no actor, so it
      // joins the turn already in progress instead of starting a phantom one.
      const last = entries[entries.length - 1];
      if (last !== undefined && typeof last.turn === 'string') {
        record.turn = last.turn;
        if (last.sessionId !== undefined) record.sessionId = last.sessionId;
      }
    }
    entries.push(record);
    while (entries.length > config.maxSnapshots) {
      const dropped = entries.shift();
      if (dropped !== undefined && typeof dropped.file === 'string') {
        try {
          unlinkSync(dropped.file);
        } catch {
          /* best effort */
        }
      }
    }
    writeIndex(root, entries);
    if (config.debug === true) {
      appendDebug(root, `snapshot ${record.id} turn=${record.turn ?? '-'} existed=${existed} path=${abs}`);
    }
  }

  /**
   * Snapshot from the filesystem service itself.
   *
   * The intent waterfalls above are the documented hook, but in a real run the
   * tool dispatches them from a context whose listener chain this plugin never
   * observes (measured: `undo` is registered and the plugin loads while zero
   * intent events arrive). `ctx.fs` hands out a fresh traceable Proxy per
   * access, so patching what `ctx.fs` returns is pointless — but every access
   * resolves the same prototype method, and the concrete backend chain is
   * `SandboxedFileSystem → LocalFileSystem → FileSystem`. Wrapping the OWNING
   * prototype method therefore intercepts every mutation no matter which scope
   * or context performs it.
   * @param service - the `fs` service implementation.
   */
  function patchFsService(service) {
    const targets = [
      ['writeText', 'fs/write-intent'],
      ['editText', 'fs/edit-intent'],
    ];
    for (const [method, event] of targets) {
      let owner = service !== null && typeof service === 'object' ? Object.getPrototypeOf(service) : null;
      let descriptor;
      while (owner !== null && owner !== Object.prototype) {
        const found = Object.getOwnPropertyDescriptor(owner, method);
        if (found !== undefined && typeof found.value === 'function') {
          descriptor = found;
          break;
        }
        owner = Object.getPrototypeOf(owner);
      }
      if (descriptor === undefined) {
        if (config.debug === true) appendDebug(root, `patch-skip ${method}: no implementation found`);
        continue;
      }
      if (descriptor.value[PATCHED] === true) {
        if (config.debug === true) appendDebug(root, `patch-skip ${method}: already wrapped`);
        continue;
      }
      const original = descriptor.value;
      const wrapped = async function patched(target, ...rest) {
        try {
          await capture(target, undefined, event, 'fs-service');
        } catch {
          /* never block the write */
        }
        return original.apply(this, [target, ...rest]);
      };
      wrapped[PATCHED] = true;
      try {
        Object.defineProperty(owner, method, { ...descriptor, value: wrapped });
        if (config.debug === true) {
          const ctor = owner.constructor !== undefined ? owner.constructor.name : '<anon>';
          appendDebug(root, `patch-ok ${method} on ${ctor}.prototype`);
        }
      } catch (error) {
        if (config.debug === true) {
          appendDebug(root, `patch-fail ${method}: ${String(error?.message ?? error)}`);
        }
      }
    }
  }

  /**
   * Register the snapshot hooks on one context scope. The fs tools dispatch
   * these waterfalls from the agent scope, which bubbles to the app root but
   * NOT to a sibling scope — and a plugin that declares `inject` gets a child
   * context, i.e. exactly such a sibling. So the hooks go on both scopes and
   * `capture` de-dupes the pair.
   * @param scope - the context to listen on.
   * @param label - which registration this is, for the debug log.
   */
  function registerHooks(scope, label) {
    const make = (event) => async (target, actor, next) => {
      try {
        await capture(target, actor, event, label);
      } catch {
        /* never block the write */
      }
      return next();
    };
    // `prepend` is load-bearing: a waterfall listener that does not call
    // `next()` vetoes everything after it, and `@deepseek-ai/dsh-fs-observation-policy`
    // is exactly such a listener — it decides the intent and returns. Plugins
    // from a profile patch load AFTER the bundled ones, so without prepend this
    // hook is never reached (measured: zero events over a full agent run).
    const options = { prepend: true };
    scope.on('fs/write-intent', make('fs/write-intent'), options);
    scope.on('fs/edit-intent', make('fs/edit-intent'), options);
  }

  registerHooks(ctx, 'plugin');
  if (ctx.root !== undefined && ctx.root !== ctx) registerHooks(ctx.root, 'root');
  if (config.debug === true) {
    // Canary: `fs/observed` is dispatched with a bare receiver, so no scope
    // filter can hide it. Its absence pins the failure on event delivery
    // itself rather than on this plugin's registrations.
    try {
      ctx.on('fs/observed', () => appendDebug(root, 'canary fs/observed'));
    } catch {
      /* diagnostics only */
    }
  }
  try {
    patchFsService(ctx.fs);
  } catch (error) {
    if (config.debug === true) appendDebug(root, `patch-fail fs: ${String(error?.message ?? error)}`);
  }

  ctx.tools.register(defineTool({
    name: 'undo',
    description: 'Undo file changes made in this workspace. Every write and edit is snapshotted before it lands, grouped by the conversation turn it happened in. action "list" shows the recent turns and the files each one changed; action "restore" rolls back every file a turn changed (default: the most recent turn), or a single snapshot when id is given. Files created during that turn are deleted. A restore is itself snapshotted, so it can be undone in turn.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'Either "list" (show recent turns) or "restore" (roll one back).'
      },
      id: {
        type: 'string',
        description: 'Snapshot id to restore on its own, for a single-file rollback. Takes precedence over turn.'
      },
      turn: {
        type: 'string',
        description: 'Which turn to restore: "last" (default), a 1-based index counted back from the newest turn ("1" = most recent, "2" = the one before), or a turn key as shown by action "list".'
      },
      limit: {
        type: 'number',
        description: 'For "list": how many turns to show (default 10).'
      },
      dryRun: {
        type: 'boolean',
        description: 'For "restore": report what each file would become without writing anything.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.message }]
    },
    async execute(args, exec) {
      const action = String(args.action ?? '').trim().toLowerCase();
      const entries = readIndex(root);
      const cwd = exec.agent?.session?.header?.cwd;

      if (action === 'list') {
        if (entries.length === 0) {
          return { ok: true, message: `没有快照。快照目录：${root}` };
        }
        const limit = Number.isSafeInteger(args.limit) && args.limit > 0
          ? Math.min(args.limit, 100)
          : 10;
        const turns = groupTurns(entries);
        const newest = turns.slice(-limit).reverse();
        const lines = newest.map((turn, index) => {
          const plan = planTurn(turn.entries);
          const when = String(turn.entries[0].time ?? '').replace('T', ' ').slice(0, 19);
          const head = `#${index + 1}  ${when}  ${plan.length} 个文件（${turn.entries.length} 条快照）  turn=${turn.turn ?? '-'}`;
          return [head, ...plan.map((entry) => `      ${entry.existed ? `${entry.bytes}B` : '新建'}  ${entry.path}`)].join('\n');
        });
        return {
          ok: true,
          message: `最近 ${newest.length} 轮（共 ${turns.length} 轮 / ${entries.length} 条快照，最新在前）：\n${lines.join('\n')}\n用 action "restore" + turn "1" 回退最近一轮的全部文件，或用 id 回退单个快照。`
        };
      }

      if (action !== 'restore') {
        return {
          ok: false,
          message: `未知的 action "${args.action}"。可用："list" 或 "restore"。`
        };
      }

      const dryRun = args.dryRun === true;
      const wanted = typeof args.id === 'string' && args.id.trim().length > 0
        ? args.id.trim()
        : undefined;

      /** One entry per path to roll back. */
      let plan;
      let scope;
      if (wanted !== undefined) {
        const entry = entries.find((candidate) => candidate.id === wanted);
        if (entry === undefined) {
          return { ok: false, message: `找不到快照 "${wanted}"。先用 action "list" 查看可用 id。` };
        }
        plan = [entry];
        scope = `快照 ${entry.id}`;
      } else {
        const turns = groupTurns(entries);
        const turn = selectTurn(turns, args.turn);
        if (turn === undefined) {
          return {
            ok: false,
            message: turns.length === 0
              ? '没有可回滚的快照。'
              : `找不到轮次 "${args.turn}"。可用 1..${turns.length}（1 = 最新），或省略表示最近一轮。`
          };
        }
        plan = planTurn(turn.entries);
        scope = `最近第 ${turns.length - turns.indexOf(turn)} 轮（turn=${turn.turn ?? '-'}）`;
      }

      if (plan.length === 0) {
        return { ok: true, message: `${scope} 没有需要回滚的文件。` };
      }

      const done = [];
      let restored = 0;
      let deleted = 0;
      let unchanged = 0;
      let failed = 0;
      for (const entry of plan) {
        let content = '';
        if (entry.existed) {
          try {
            content = readFileSync(entry.file, 'utf8');
          } catch (error) {
            failed += 1;
            done.push(`失败  ${entry.path}：快照内容读取失败（${String(error?.message ?? error)}）`);
            continue;
          }
        }
        if (dryRun) {
          try {
            const target = await ctx.fs.resolve(entry.path, { cwd, signal: exec.signal });
            const info = await ctx.fs.stat(target);
            if (info === undefined) {
              if (entry.existed) {
                restored += 1;
                done.push(`将写入  ${entry.path}（当前不存在，按快照恢复 ${Buffer.byteLength(content)} 字节）`);
              } else {
                unchanged += 1;
                done.push(`无变化  ${entry.path}（本轮期间新建，当前也已不存在）`);
              }
            } else if (!entry.existed) {
              deleted += 1;
              done.push(`将删除  ${entry.path}（本轮期间新建）`);
            } else {
              const current = await ctx.fs.readText(target);
              if (current === content) {
                unchanged += 1;
                done.push(`无变化  ${entry.path}（当前内容已与快照一致）`);
              } else {
                restored += 1;
                done.push(`将写入  ${entry.path}（当前 ${Buffer.byteLength(current)} 字节 → 快照 ${Buffer.byteLength(content)} 字节）`);
              }
            }
          } catch (error) {
            failed += 1;
            done.push(`无法预演 ${entry.path}：${String(error?.message ?? error)}`);
          }
          continue;
        }
        try {
          if (entry.existed) {
            const target = await ctx.fs.resolve(entry.path, { cwd, signal: exec.signal });
            await ctx.fs.writeText(target, content, undefined, exec.signal);
            restored += 1;
            done.push(`已写入  ${entry.path}（恢复 ${Buffer.byteLength(content)} 字节）`);
          } else {
            // The file did not exist when the turn started: rolling that back
            // means removing it again.
            unlinkSync(entry.path);
            deleted += 1;
            done.push(`已删除  ${entry.path}（本轮期间新建）`);
          }
        } catch (error) {
          failed += 1;
          done.push(`失败  ${entry.path}：${String(error?.message ?? error)}`);
        }
      }

      const verb = dryRun ? '预演' : '回滚';
      const summary = dryRun
        ? `预演 ${scope}：将写入 ${restored} 个、删除 ${deleted} 个、无变化 ${unchanged} 个${failed > 0 ? `、失败 ${failed} 个` : ''}。未做任何修改。`
        : `${scope} 已回滚：写入 ${restored} 个、删除 ${deleted} 个${failed > 0 ? `、失败 ${failed} 个` : ''}。`;
      return { ok: failed === 0, message: `${summary}\n${done.join('\n')}` };
    }
  }));
}

export { Config, apply, inject, name };
