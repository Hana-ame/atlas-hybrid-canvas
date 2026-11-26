# v94 代码审查 — 01

> 审查日期：2026-11-25
> 审查范围：`atlas-hybrid-canvas-v94.zip` 中 v94 相对 v93 的全部改动及联动调用点
> 结论：**可发布**（无阻断问题；`v93-review-01.md` 的 4 项非阻断问题均已闭环并补齐回归测试，仅存在 3 项低风险非阻断细节）。

## 非阻断问题

1. 文件头注释残留旧快捷键说明（`src/canvas/ControllableEdge.tsx:6`）：顶部注释仍写有「亦支持 Alt/Shift+双击连线插入」，与代码实现不一致。
2. `insertControlPoint()` 缺少非有限坐标守卫且 `hasOnUpdate` 传参冗余（`src/core/edgePath.ts:279-290`、`src/canvas/ControllableEdge.tsx:107`）。
3. 多端口节点缺省 `handleId` 时全景锚点与 React Flow 存在细微偏差（`src/core/edgePath.ts:90-92`）：React Flow 默认连接首个端口（33.3%），而 `resolveNodePortY()` 原回落至 50%。
