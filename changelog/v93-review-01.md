# v93 代码审查 — 01

> 审查日期：2026-11-25
> 审查对象：v93 改动（`src/core/edgePath.ts`、`src/canvas/ControllableEdge.tsx`、`src/canvas/ChunkUnderlayCanvas.tsx`、`src/App.tsx`）
> 结论：**无阻断问题**，发现 4 项非阻断问题（默认双入端口全景对齐、Shift 键位冲突、拖拽会话边界守卫与双击回归测试/重复公式清理）。

## 非阻断问题

1. `resolveNodePortY()` 未在 `node.inputPorts === undefined` 时回退到 `WidgetNode` 的 `DEFAULT_INPUT_PORTS`（`in-1`/`in-2`），导致 `node-lore-north` 等默认节点缩远切入 `macro` 时入端点在 33.3%/66.7% 与 50% 间跳变。
2. `ControllableEdge.tsx` 的 `handleEdgeDoubleClick` 同时响应 `Shift + 双击`，与 `<ReactFlow selectionKeyCode="Shift" multiSelectionKeyCode="Shift" />` 冲突。
3. `createControlPointDragSession()` 缺少 `index` 越界与 `screenToFlow()` 非有限值守卫；重启拖拽会话前未清空可能残留的旧 `draftPoints`。
4. v93 阻断修复（双击编辑标签）缺少独立自动化回归测试；`ChunkUnderlayCanvas.tsx` 全景箭头仍手写两遍三次贝塞尔多项式而非复用 `evalCubicBezier()`。
