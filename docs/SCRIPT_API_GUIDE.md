# 控件统一脚本与安全沙箱开发指南

Atlas Hybrid Canvas 的每个控件（`BlueprintNode`）都支持两种脚本模式：
1. **单按钮短脚本**：在右侧属性面板的「交互按钮与脚本」中给某个按钮单独写几行代码。
2. **统一脚本（Code-as-UI，`entity.script`）**：一段脚本同时声明控件内部的动态 UI（`vars.contents`）并注册点击、回车提交与跨控件消息回调。

## 一、安全沙箱运行机制（`src/core/scriptSandbox.ts`）

所有用户脚本均按以下四重防线执行：
1. **静态危险词拦截**：保存/执行前通过 `validateScriptSafety()` 扫描，禁止 `window`、`document`、`globalThis`、`localStorage`、`sessionStorage`、`indexedDB`、`cookie`、`eval`、`Function`、`Proxy`、`Reflect`、`fetch`、`XMLHttpRequest`、`WebSocket`、`Worker`、`importScripts`、`__proto__`、`prototype`、`constructor` 等，且单段脚本上限 `24 KB`。
2. **一次性 Blob Web Worker 隔离**：每次执行动态拼装启动器并拉起全新 Web Worker，Worker 天然无法访问主页面 DOM、Cookie 与存储，同时在 `AsyncFunction` 参数中把危险全局名显式遮蔽为 `undefined`。
3. **5 秒 CPU 看门狗强杀**：若脚本包含死循环或超长阻塞计算，超过 `5000ms` 自动 `worker.terminate()` 并释放 Blob URL，页面绝不卡死。
4. **跨控件消息防环保护**：主线程调度 `emit` / `broadcast` 时限制最大递归深度 `depth <= 4`，防止 A → B → A 无限互发消息。

## 二、内置全局 API 速查

| 全局对象 / 函数 | 说明 | 示例 |
| --- | --- | --- |
| `vars` | 当前控件实时变量对象（读写自动同步至本地 `runtimeVars`） | `vars.score = 100;` |
| `vars.contents` | 声明式流式 UI 数组，支持文本、按钮、输入框与水平行数组 | 见下文示例 |
| `ctx.entity` | 当前控件只读元信息（`id`, `title`, `x`, `y`, `width`, `height`, `color`） | `ctx.entity.title` |
| `lib.now()` | 返回当前本地时间字符串 | `vars.at = lib.now();` |
| `lib.inc(key, delta=1)` | 安全累加数字变量并返回新值 | `const n = lib.inc('count', 1);` |
| `log(...args)` | 输出日志至底部状态栏 | `log('完成', vars.count);` |
| `on(idOrEvent, fn)` | 注册按钮点击回调或跨控件事件监听 `(payload, meta) => {}` | `on('ping', (msg, meta) => ...)` |
| `onSubmit(inputId, fn)` | 注册单行输入框按 Enter 回车时的提交回调 `(val) => {}` | `onSubmit('msgInput', (v) => ...)` |
| `widgets.get(id)` | 读取任意其他控件的快照（含 `title` 与 `vars`） | `widgets.get('node-world-hub')` |
| `widgets.vars(id)` | 读取指定控件的实时变量表 | `widgets.vars(vars.lastChildId)` |
| `widgets.list()` | 获取画布上全部控件快照数组 | `widgets.list().length` |
| `await widgets.create(spec)` | 动态创建新子控件并可自动连线 | 见下方示例 |
| `widgets.connect(from, to, label?)` | 在两个控件间编程式建立带箭头连线 | `widgets.connect(ctx.entity.id, id, '触发')` |
| `widgets.remove(id)` | 移除指定控件及其连线 | `widgets.remove(oldId)` |
| `await emit(targetId, event, payload)` | 向指定控件发送消息并触发其 `on(event)` | `await emit(childId, 'ping', { text })` |
| `await broadcast(event, payload)` | 向全画布所有带脚本控件广播消息 | `await broadcast('resetAll', {})` |
| `canvas.setAnnotationBg(id, hex, opacity?)` | 修改指定背景文本框/插图的色块背景 | `canvas.setAnnotationBg('ann-zone-0', '#FEF3C7', 0.9)` |
| `canvas.setAnnotationColor(id, hex)` | 修改指定背景注释的文字颜色 | `canvas.setAnnotationColor('ann-zone-0', '#1E3A8A')` |
| `canvas.setAnnotationText(id, text)` | 动态改写指定背景注释文案 | `canvas.setAnnotationText('ann-zone-0', '阶段二：已上线')` |
| `canvas.setAnnotationImage(id, url)` | 动态切换背景插图的图片地址 | `canvas.setAnnotationImage('ann-img-1', url)` |

## 三、`vars.contents` 声明式流式 UI 写法

`vars.contents` 是一个数组，每一项可以是单个块对象，也可以是用 `[...]` 包起来的**水平行数组**：

```js
vars.contents = [
  // 1. 文本块
  { type: 'text', text: '当前计数：' + (vars.count || 0), align: 'center', color: '#1E40AF', fontSize: 13, bold: true },

  // 2. 水平并排的输入框 + 按钮（按回车自动触发 onSubmit('msgInput', val)）
  [
    { type: 'input', id: 'msgInput', bind: 'draft', placeholder: '输入内容按回车发送...' },
    { type: 'button', id: 'send', label: '发送', width: 68, variant: 'success' }
  ],

  // 3. 多行文本域
  { type: 'textarea', id: 'memo', bind: 'memoText', placeholder: '备注...' }
];
```

## 四、完整示例：动态造子控件并双向通信

```js
const n = Number(vars.count) || 0;
vars.contents = [
  { type: 'text', text: '已创建子控件：' + n, bold: true, align: 'center' },
  { type: 'button', id: 'spawn', label: '+ 创建并连线', variant: 'primary' },
  { type: 'text', text: vars.status || '等待操作', fontSize: 11, color: '#475569' }
];

on('spawn', async () => {
  const next = n + 1;
  const res = await widgets.create({
    title: '子任务 #' + next,
    dx: 420,
    dy: (next - 1) * 180,
    w: 280,
    h: 160,
    color: '#059669',
    connect: '派发 #' + next,
    vars: { parentId: ctx.entity.id, done: false },
    script: `
      vars.contents = [
        { type: 'text', text: vars.done ? '已完成' : '待执行', bold: true },
        { type: 'button', id: 'finish', label: '汇报完成', variant: 'success' }
      ];
      on('finish', async () => {
        vars.done = true;
        await emit(vars.parentId, 'doneReport', { from: ctx.entity.title });
      });
    `
  });
  if (res.ok) {
    vars.count = next;
    vars.status = '已创建 ' + res.title;
  }
});

on('doneReport', (msg) => {
  vars.status = '收到汇报：' + msg.from + ' 已完成！';
});
```


## 连线数据通路 API（v19 新增）

控件之间通过端口连线后，下游脚本无需写死上游 `id`，可直接按端口读取上游数据或沿出口连线向下游推送事件：

- `widgets.inputs(portId?)`：返回连入当前控件入口（或指定端口如 `'in-1'`）的上游控件快照数组，每项包含 `id / title / body / vars / edgeId / fromPort / toPort / edgeLabel`。
- `widgets.outputs(portId?)`：返回从当前控件出口连出的下游控件快照数组。
- `emitDownstream(event, payload, portId?)`：沿当前出口连线向所有下游控件投递事件（接收方用 `on(event, (payload, meta) => ...)` 处理）。
- 当上游修改正文（例如勾选 `- [ ]` 复选框）、执行脚本修改 `vars`，或建立/删除连线时，已连线的下游脚本控件会自动触发实时刷新。


## 用 `vars` 动态控制控件形态（v22 新增）

控件脚本写入以下保留字段时，会实时驱动该控件的渲染属性与空间坐标（且保留在本地叠加层，不污染后端底座）：

- `vars.type` / `vars.category`：动态修改左上角类型徽标文字；
- `vars.title`：动态修改控件标题；
- `vars.color`：动态修改顶部边框与徽标主题色；
- `vars.width` / `vars.height`：动态修改控件宽高（自动安全钳位在 `180–1400` / `100–1200`）；
- `vars.pos`（`{ x, y }` 或 `[x, y]`）或 `vars.x` / `vars.y`：动态移动控件在无限画布中的世界坐标；
- `vars.locked`：动态切换控件锁定状态。
