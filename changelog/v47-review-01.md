# v47 Review 01 — `onChange` 响应式订阅与脚本日志面板回归评审

## 评审范围
- 核查 `src/core/scriptSandbox.ts` 中 `onChange` 注册去重、深比较 diff、链式派生与防死循环上限。
- 核查 `src/App.tsx` 中 `handleUpdateDefaultVar` / `handleDeleteDefaultVar` 与 `runtimeVars` 同步，以及 `scriptLogsByNode` 内存上限。
- 核查 `src/components/NodeInspectorPanel.tsx` 日志面板滚动隔离（`nowheel`）与错误筛选状态。

## 评审结论
- **防重复注册与防死循环**：`runUserCode()` 每次执行前重置 `changeHandlers`，避免第 2 遍重渲染重复挂载回调；`runChangeWatchers()` 限制 `MAX_REACTION_PASSES = 3`，实测 `a <-> b` 互相修改可安全收敛并正常返回。
- **避免 `runtimeVars` 遮蔽检查器编辑**：`handleUpdateDefaultVar` / `handleDeleteDefaultVar` 同步更新 `overlay.runtimeVars[nodeId]` 后再触发 `varsChanged`，防止旧运行时值覆盖刚编辑的变量。
- **内存与交互隔离**：日志按节点上限 50 条截断，容器使用 `nowheel` 避免滚动日志误缩放画布。
