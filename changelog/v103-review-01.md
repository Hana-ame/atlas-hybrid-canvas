# v103 代码审查 — 01

> 审查日期：2026-11-27
> 审查范围：相对 `c1c8136`（v102）的全部改动
> 结论：**可发布**（无阻断）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 控件历史浮窗 | `src/components/WidgetHistoryPopover.tsx` | 独立浮窗组件，带 `nodrag nopan nowheel` 与指针事件阻止冒泡，按版本倒序展示 |
| 控件常驻历史按钮 | `src/canvas/WidgetNode.tsx` | 历史按钮与锁按钮同为首屏常驻可见，点击切换对应控件历史浮窗 |
| 状态联动 | `src/App.tsx` | `widgetHistoryNodeId` 状态驱动加载与互斥关闭 |
| 单元测试 | `tests/uiComponents.test.ts` | 新增常驻历史按钮与浮窗渲染测试，200/200 通过 |

## 审查发现

### 已确认正确

1. **首屏可见**：历史按钮置于控件卡片右上角常驻区，未折叠进 hover 工具栏或二级抽屉。
2. **画布手势隔离**：浮窗容器与关闭按钮均阻断 `pointerdown`/`mousedown` 冒泡并声明 `nodrag nopan nowheel`，避免滚动或点击误触发画布平移与节点拖拽。

### 非阻断问题

1. **当前浮窗复用房间级历史条目**：服务端目前仅存储房间级快照，`WidgetHistoryPopover` 先展示房间级快照记录并引导通过顶栏「版本历史」执行回档；后续可扩展服务端按控件维度 diff。
2. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，200/200 通过。
