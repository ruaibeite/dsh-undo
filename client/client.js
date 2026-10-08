/**
 * @ruaibeite/dsh-undo — 浏览器半边（client half）。
 *
 * 在已定稿助手消息的动作行（`conversation.chat.assistant-actions`）里放一个
 * 「回退本轮」按钮。点击后走**宿主命令** `/undo 1`，因此：
 *
 * - 与模型可调的 `undo` 工具、以及人工输入的 `/undo` **共用同一套执行逻辑**，
 *   三处行为不会漂移；
 * - 结果按宿主命令的正常方式呈现（作为一条命令结果进入会话），不需要客户端
 *   自己拼报告，也不需要新增任何自定义 Remote。
 *
 * 按钮只做一件事：回退最近一轮。回退本身也会被宿主快照，所以再点一次即可
 * 撤销这次回退（等效 redo）。只想预览、不写盘时，用 `/undo dry` 命令。
 *
 * 本文件是**手写的**预构建客户端入口，不需要任何打包步骤：浏览器端
 * `__ModuleLoader__` 会执行它，工厂函数拿到宿主的 `require`（React 与官方
 * 客户端包都由宿主提供）。
 */
window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-undo',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');

    const name = 'tool-undo-client';

    /**
     * 客户端服务：插槽注册表，以及用来执行宿主命令的命令 UI。
     *
     * `remote` / `remote.commands` 也在列表里：cordis 的严格服务访问会把
     * `ctx.commandUi.execute()` 内部的 `ctx.remote.commands` 访问归到**调用方**
     * （也就是本插件）头上，不声明就会抛
     * `cannot get property "remote.commands" without inject`
     * —— 这个错是真实点击时抓到的，官方 ui-commands 客户端同样声明了这两项。
     */
    const inject = ['slots', 'commandUi', 'remote', 'remote.commands'];

    /** 按钮外观：与消息动作行里其它图标按钮一致的极简样式。 */
    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 6px',
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      lineHeight: '1.4',
      cursor: 'pointer',
      opacity: '0.75'
    };
    const NOTE_STYLE = { fontSize: '0.85em', opacity: '0.85', maxWidth: '22em' };

    /**
     * 动作行里的按钮。
     * @param props - 插槽框架的 share 加上本条目 `inject` 注入的 `runUndo`。
     */
    function UndoAction(props) {
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const run = props.runUndo;
      const onClick = (event) => {
        if (event !== undefined && event !== null) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        if (busy || typeof run !== 'function') return;
        setBusy(true);
        setNote(null);
        Promise.resolve()
          .then(() => run('/undo 1'))
          .then((outcome) => {
            setBusy(false);
            const failed = outcome !== undefined && outcome !== null && outcome.kind === 'error';
            if (failed) {
              setNote(typeof outcome.text === 'string' && outcome.text.length > 0 ? outcome.text : '回退失败');
            }
          }, (error) => {
            setBusy(false);
            setNote(String((error !== undefined && error !== null && error.message) || error));
          });
      };
      const children = [busy ? '…' : '↶'];
      if (note !== null) children.push(React.createElement('span', { key: 'note', style: NOTE_STYLE }, note));
      return React.createElement('button', {
        type: 'button',
        title: '回退最近一轮的文件修改（回退也会被快照，再点一次即可撤销这次回退）',
        'aria-label': '回退最近一轮',
        disabled: busy,
        onClick,
        style: BUTTON_STYLE
      }, children);
    }

    /**
     * 注册按钮。插槽由 `ui-conversation` 声明，本条目追加在动作行里
     * （`order` 大于官方反馈条目的 10，排在它之后）。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'undo-turn',
        order: 20,
        // 按会话注入：组件因此拿到一个已经把 sessionId 绑好的「跑 /undo」函数，
        // 不必自己去解析会话。
        inject: (sessionId) => ({
          runUndo: (line) => ctx.commandUi.execute({ sessionId }, line)
        })
      }, UndoAction));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  }
});
