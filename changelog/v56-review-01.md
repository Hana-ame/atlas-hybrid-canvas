# v56 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：`src/App.tsx`、`src/canvas/WidgetNode.tsx`、`src/canvas/AnnotationNode.tsx`、`src/canvas/PdfViewerBlock.tsx`、`src/core/apiCore.ts`
> 结论：**通过**

## 核验要点

- **左/上拉伸坐标与 `vars.pos` 冲突处理**：`handlePatchNode` 写入 `x`/`y` 前会经过 `clearConflictingRuntimeVars`，若脚本此前设过 `vars.pos/x/y` 也会一并清理，不会弹回。
- **`ResizeObserver` 生命周期**：依赖 `[isLocked]` 后，在输入态卸载旧 observer、进入查看态立即绑定新 DOM，并在卸载时 `ro.disconnect()` 无泄漏。
- **定时器清理**：`apiCore.ts` 的 `finally` 无论 `fetch` 成功、失败还是超时均清理 `timeoutId`，测试退出时间直降 10s 印证无残留句柄。
