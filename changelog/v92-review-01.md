# v92 代码审查 — 01

> 审查日期：2026-11-25
> 审查对象：v92 改动（`src/canvas/ControllableEdge.tsx`、`src/core/edgePath.ts`、`src/canvas/ChunkUnderlayCanvas.tsx`、`src/App.tsx`、`src/core/agentOps.ts`、`src/core/seedBlueprint.ts`）
> 结论：**需修改**。发现 1 项阻断级功能回归（双击编辑连线标签被吞掉）与 6 项非阻断问题（含 v91 3 项 P0 缺少自动化回归测试）。

## 已逐行阅读范围

- `src/canvas/ControllableEdge.tsx`（全文）
- `src/core/edgePath.ts`（全文）
- `src/canvas/ChunkUnderlayCanvas.tsx:392-470`
- `src/App.tsx:2000-2065, 2580-2635`
- `src/core/agentOps.ts:355-380, 715-735`
- `src/core/seedBlueprint.ts:1025-1040, 1140-1160`

## 阻断问题

1. **双击编辑连线标签被完全吞掉（`ControllableEdge.tsx:142-158, 182, 297`、`App.tsx:2609-2627`）**：外层 `<g>` 与标签胶囊 `<div>` 均拦截 `onDoubleClick` 并 `stopPropagation()`，导致 `<ReactFlow onEdgeDoubleClick>` 永远收不到事件。

## 非阻断问题

1. `pointercancel` 复用了 `handleUp` 提交逻辑而非回滚（触控中断或 `+` 插入取消会误落盘）。
2. 拖拽缺少位移阈值，双击删点伴随 1–2px 抖动仍会先提交一次微移。
3. v91 的 3 项 P0 阻断修复缺少自动化回归测试（违反 `changelog/qa-workflow-and-review-playbook.md` 关单约束）。
4. 全景 `macro` 模式硬编码节点中心 `0.5`，忽略多端口纵向偏移，缩放切换时端点跳变。
5. ZONE F `cancel` 控制点（`y = 2016`）压在 `ann-zone-fsm` 横幅底边（`y: 1975..2021`）。
6. 细节瑕疵：只读模式（`!onUpdate`）控制点仍可抓起；未按 `ev.pointerId` 过滤多指触控；`summarizeBlueprintForAgent` 先判 length 再清洗脏控制点；`segmentMidpoints`/`labelX/Y` 取折线弦中点而非真实三次贝塞尔 `B(t)`。

## 未覆盖盲区

- 真实浏览器指针/触控交互与 Playwright 端到端烟测尚未在沙箱内执行。
