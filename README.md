# dsh-undo — 按轮次回退 agent 对文件的修改

给 DeepSeek Harness 加一个**文件回滚**能力：每次写入或编辑**落盘之前**先把原内容快照
下来，模型可以调用 `undo` 工具把**一整轮对话改动过的所有文件**一次退回 —— 不是只能退
单个文件。

## 定位：它和「对话回退」类插件不是一回事

| | 本插件 | 对话回退类（如 `dsh-rewind-plugin`、`dsh-recall-plugin`） |
|---|---|---|
| 回滚对象 | **文件**（本轮改动过的全部文件） | 对话上下文 **+** 文件 |
| 谁来触发 | **模型自己**调 `undo` 工具（agent 发现改错了可以自己回退） | 人在界面上点按钮 / 敲命令 |
| 运行环境 | host 侧插件，**headless、无 Web UI 的 profile 同样可用** | 主要在 Web GUI 里用 |
| 依赖 | 无（不依赖 git） | 多数依赖 git 或会话 fork 机制 |

需要「把对话切回某条消息之前」请用上面那两个插件；本插件只做文件层，且刻意保持轻量。

## 它怎么工作

两条互补的捕获路径，都只做旁路记录、不改变任何写入语义：

| 路径 | 位置 | 说明 |
|---|---|---|
| ① intent 钩子（主） | `fs/write-intent` / `fs/edit-intent` waterfall | DSH 的官方扩展点，能拿到 actor（`callId`、`agent`）等工具执行信息 |
| ② fs 服务包装（兜底） | `writeText` / `editText` 的实现原型 | 若 ① 因任何原因收不到事件，② 保证仍然有快照 |

三条经验性的结论，都已落在代码里（细节见 `lib/index.js` 注释）：

1. **intent 钩子必须 `prepend: true`。** cordis 的 waterfall 语义是「不调用 `next()` 的
   监听器会否决其后的整条链」，而 `@deepseek-ai/dsh-fs-observation-policy` 正是这样一个
   监听器（它直接决定 intent 并返回）。profile 补丁里的插件加载**晚于**内置插件，所以不
   prepend 的话钩子永远轮不到执行 —— 实测跑完整个 agent 会话，零事件到达。
2. **服务包装是必需的冗余。** 真实链路是
   `SandboxedFileSystem → LocalFileSystem → FileSystem`，而 `ctx.fs` 每次访问都返回
   **新的 traceable Proxy**，所以包装 `ctx.fs` 上的方法没有意义，必须包装方法**所属的原型**。
3. **两条路径会同时命中同一次写入**，因此有跨机制去重：同一路径 + 同一事件 + 250 ms 内、
   且来自**不同**机制时只记一条。同一机制内的连续两次写入不会被误合并。

### 轮次是怎么分出来的

工具执行上下文里只有 `callId` / `rootCallId` / `agent`，没有轮次号，所以轮次边界取自
**会话日志中最近一条 `user/message` 事件的 seq**（只扫描尾部 `sessionScanEvents` 条，
并按 `(session, seq)` 缓存，代价有界）。读不到会话的写入（例如 fs 服务兜底路径）会归入
「当前正在进行的轮次」，而不是自成一派。

## 提供的工具

模型可调用 `undo`：

| 参数 | 说明 |
|---|---|
| `action` | `list` = 按轮次列出快照；`restore` = 回滚 |
| `id` | 回滚单个快照（单文件精细回退）；给出时优先于 `turn` |
| `turn` | 回滚哪一轮：`last`（默认）、从新到旧计数 `1`/`2`/…，或 `list` 显示的 turn 键 |
| `limit` | `list` 时返回多少轮，默认 10 |
| `dryRun` | `restore` 时只报告每个文件会变成什么，不写盘 |

### 回滚语义

- 一轮里同一文件被多次快照（改了两遍）→ 取**最早**那条，即该文件在本轮开始前的状态。
- 本轮期间**新建**的文件 → 回滚 = 删除它。
- 回滚动作本身也会被快照 → **回滚可以再撤销**（等效 redo）。
- 单个文件失败不会中止整轮：报告里逐条列出成功/失败。

## 安装

```sh
# 从 GitHub 安装（推荐；package.json 里的 dsh.bundle 让 dsh 自动挂载）
dsh plugin --profile web add github:ruaibeite/dsh-undo

# 或本地克隆后用脚本（自动改用桌面版自带的 CLI）
./install.sh
PROFILE_NAME=headless ./install.sh
```

安装后重启 dsh 生效。

## 存储与配置

```
$DSH_HOME/undo/
├── index.json                 # 快照索引，每条含 id/time/path/existed/bytes/turn/sessionId
└── files/<快照id>             # 快照内容（逐字节）
```

`$DSH_HOME` 内部的写入会被排除（那是 harness 自身状态，不是工作区文件）。

`cordis.patch.yml` 里该条目可配：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxSnapshots` | 300 | 保留快照条数上限，超出淘汰最旧的 |
| `maxFileBytes` | 4194304 | 超过此大小的文件不快照 |
| `onlyToolWrites` | false | `true` 时只快照带工具 actor 的写入 |
| `sessionScanEvents` | 400 | 为定位轮次边界而扫描的会话日志尾部条数 |
| `listFilesPerTurn` | 10 | `action: "list"` 每轮最多列出多少条文件，其余用一行省略汇总（`list` 带上 `turn` 则打印该轮全量清单） |
| `debug` | false | `true` 时把每个事件写入 `$DSH_HOME/undo/debug.log` |

## 限制（如实说明）

- **只回滚文件，不回滚对话。** 对话层回退请用专门的插件。
- **只看得见经 `ctx.fs` 的写入。** 通过 shell 等绕过 fs 直接落盘的改动不会产生快照；不过
  这些文件在被工具再次写入时，会以「当时已存在」的形态被快照。
- 超过 `maxFileBytes` 的单个文件不快照。
- 轮次分组依赖会话日志里存在 `user/message` 事件；取不到时退化为按工具调用分组。
- 快照只写 `$DSH_HOME`，不改工作区、不碰你的 git 仓库、无网络请求。

## 测试

```sh
npm install        # 官方包从 npm 安装（devDependencies，0.2.0-rc.2 线）
npm test           # 业务逻辑：mock fs/tools/agent，36 项断言
npm run test:integration   # 真实 cordis 容器 + 真实 waterfall 分发 + 真实 Config 校验，15 项断言
```

两套测试都用隔离的 `DSH_HOME`（仓库内 `.test-home` / `.cordis-test-home`），跑完自动清理。

## 许可

MIT
