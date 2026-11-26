# v91 代码审查 — 02

> 审查日期：2026-11-25
> 审查对象：v91 新增的 `src/canvas/ControllableEdge.tsx`、`src/core/edgePath.ts`、`src/App.tsx` 连线接入、`src/core/agentOps.ts` `controlPoints` 与 `src/core/seedBlueprint.ts` ZONE F 预设控制点
> 结论：**需修改**。发现 3 项阻断级交互/内存泄漏缺陷与 4 项非阻断问题。
> 来源：本文件由 v95 交付包带入，原编号为 `01`，与仓库已提交的 `changelog/v91-review-01.md` 冲突；按 `AGENTS.md`「同一版本审查序号递增、不复用不覆盖」顺延为 `02`，正文除标题序号外未作改动。

## 阻断问题

1. **右键删除控制点会被 `pointerup` 立即复活（`src/canvas/ControllableEdge.tsx:67-102, 202-204`）**：`startDragControlPoint` 未校验 `ev.button !== 0`，右键触发 `pointerdown` 存入旧 `draftRef`，`contextmenu` 删除后松开右键触发 `pointerup` 用旧数组覆写恢复。
2. **单击或双击删除控制点无条件提交空操作（`src/canvas/ControllableEdge.tsx:84-95`、`src/App.tsx:2000-2022`）**：未拖动松手仍调 `onUpdate`；双击删除先触发 2 次空提交再删，共污染 3 次撤销栈与 3 次 `rev` 广播；且 `handleUpdateEdgeControlPoints` 在校验 `cur` 前已压入历史栈。
3. **拖拽中途卸载泄漏 `window` 事件监听（`src/canvas/ControllableEdge.tsx:97-110`）**：`useEffect` 卸载清理未移除 `pointermove`/`pointerup`/`pointercancel`，缩远切 `macro` LOD 或删边会残留全局监听。

## 非阻断问题

- `src/core/agentOps.ts`：`getAgentToolSchema()` 未声明 `controlPoints`，`summarizeBlueprintForAgent()` 未返回 `edges[].controlPoints`，且 `connect_edge` 传入 `[]` 未归一化为 `undefined`。
- `src/canvas/ChunkUnderlayCanvas.tsx:397-417`：全景 `macro` 模式未沿 `edge.controlPoints` 绘制样条。
- `src/canvas/ControllableEdge.tsx:172-193`：双向连线（含 `markerStart`）仍绘制起点实心圆，与起头箭头重叠。
- `changelog/v91.md` 缺少发布日期与验证段落（历史文件只读，留待 v92 按 `AGENTS.md` 规范撰写）。
