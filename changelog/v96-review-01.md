# v96 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：`atlas-hybrid-canvas-fixed.zip`（基于提交 `62a765d`）相对 v95 的 4 个文件改动，以及 README 同步与新增独立测试
> 结论：**可发布**（无阻断问题；2 项非阻断，均为多人协同/交互细节，不影响单人主流程）

审查方式：逐行对比 zip 与 HEAD，手算几何验证「+」手柄避让位置，独立编写 5 条测试；不采信交付包自带结论，本地不跑构建与测试。

## 改动范围核对

| 文件 | 改动 | 核对 |
| --- | --- | --- |
| `src/App.tsx` | 内联编辑状态、`onEdgesChange` 选中镜像、`onPaneClick` 清理 | 与 `ControllableEdge` 的新回调契约一一对应 |
| `src/canvas/ControllableEdge.tsx` | 内联输入框、事件隔离、悬停延迟、手柄避让 | 与 v95 的拖拽状态机接口保持兼容，未回退 4px 阈值/pointercancel 回滚 |
| `src/index.css` | `.edge-control-handle` 强制 `pointer-events: all` / `touch-action: none` | 与组件内联 style 双保险，选择器覆盖子元素 |
| `tests/uiComponents.test.ts` | 新增 2 条 pointer-events 断言 | 断言口径为「字符串出现」，另由独立测试补强 |
| `README.md` / `changelog/` | README v12→v96，补 v96 版本与审查文件 | 与 `AGENTS.md` 命名、序号、同提交约束一致 |
| `tests/inlineLabelIndependent.test.ts` | 新增 5 条独立测试 | 不复用项目自带测试的断言口径 |

## 审查发现

### 已确认正确

1. **连线标签链路的原生弹窗已移除**：`ControllableEdge` 中无 `window.prompt` / `window.alert` 调用，`App.tsx` 中不再有 `window.prompt('修改连线标签...')`（`App.tsx:1817` 的模板命名 prompt 属其它场景，不在本次范围）。`Enter` 与 `onBlur` 都走 `commitInlineLabel`，`editClosedRef.current` 在第一次调用时置位，第二次直接返回，撤销栈与 `rev` 不会双写。
2. **IME 安全**：`onKeyDown` 先 `ev.stopPropagation()`，再 `if (ev.nativeEvent.isComposing) return`，中文候选期按 Enter 不会误提交。
3. **空写不污染撤销栈**：`handleCommitEdgeLabel` 先 `normalized = nextLabel.trim() || undefined`，与 `initial.label || undefined` 相等即 return，`pushHistory()` 在其后（顺序已由独立⑤源码断言锁定）。`handleEditEdgeLabel` 只切编辑态，不动 base。
4. **事件分层正确**：控制手柄与「+」手柄为 `pointer-events: all` + `nodrag nopan` + `touch-action: none`，`onMouseDown` / `onTouchStart` 阻断冒泡；外发光、「+」内十字、起点实心圆均为 `pointer-events: none`。命中热区仍是 `strokeWidth=18` 的透明路径。
5. **拖拽状态机未被回退**：`createControlPointDragSession` 的 4px 阈值、`pointerId` 隔离、`pointercancel` 回滚、`cleanup()` 幂等全部保留；本版只把 `window` 监听改为捕获阶段，并在 `cleanup` 中一并 `setDragging(false)`，注销用同一组函数引用，不会泄漏。
6. **避让显示与落盘一致**：`(0,0)→(400,200)` 无控制点时 `dx = 180`，`B(0.5) = (200,100)`，与 `segmentMidpoints[0]` 重合，触发 `28px` 半径避让后手柄移到 `(200,122)`；点击时用 `handleX / handleY` 写入，显示位置即落盘位置，不会出现「点在下方、点在上方」的错位。
7. **编辑态手柄显隐合理**：编辑时隐藏「+」手柄，但保留已落盘控制点与样条路径，用户可在输入框打开时继续看到走向。
8. **定时器清理**：`handleMouseLeave` 的 `120ms` 延迟定时器在卸载时清理，`handleMouseEnter` 会取消未触发的退出定时器，不会在卸载后 `setState`。
9. **选中态闭环**：`onEdgesChange` 处理 `select` 变更并镜像到 `selectedEdgeIds`，删除连线时同步移除选中项与对应编辑态，`onPaneClick` 再兜底关闭编辑态。

### 非阻断问题

1. **协同并发下本地草稿可能被远端覆盖**（`ControllableEdge.tsx:103-115`）：`useEffect` 依赖 `[isEditingLabel, label]`，编辑期间若有远端 WS 更新同一条边的 `label`，effect 重跑并把 `draftLabel` 重置为远端值，用户正在输入的内容丢失。影响面：仅多人协同且两人同时编辑同一标签时触发；单人保存流程不受影响。处理动作：**未改，记入 `changelog/v96.md` 已知遗留**。
2. **点击画布时两次状态更新**：输入框失焦先提交（`setEditingEdgeLabelId(null)`），随后 `onPaneClick` 再设一次 null。结果幂等、无可见闪烁，只是多一次渲染。影响面：所有用户，仅性能层面。处理动作：**未改，非阻断**。

### 阻断问题

无。

## 验证记录

- 独立测试：`tests/inlineLabelIndependent.test.ts` 5 条，按 `(0,0)→(400,200)` 手算 `(200,100)` / `(200,122)` 正反两面断言；`tests/` 共 184 条 `test()` 声明（源码计数）。
- `EdgeLabelRenderer` 仅在 `ReactFlow` 提供 `domNode` 时才 `createPortal`，SSR 下返回 null，因此输入框本身改由源码级断言守护（无原生弹窗、IME 分支、Enter/Blur/Escape 三分支、归一化先于 `pushHistory`），不写会因 SSR 恒空而失败的假测试。
- `npm run typecheck` 的 `include` 仅为 `src` / `server` / `vite.config.ts`，不含 `tests/`；测试文件正确性由 `npm test` 运行时断言覆盖。
- CI 与 Pages：本地不执行，推送后以 GitHub Actions run 回执、部署产物 hash 与 HTTP 200 为准（见本次推送后的报告）。
