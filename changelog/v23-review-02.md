# v23 代码审查 — 02

> 审查日期：2026-11-23
> 审查范围：复核 `v23-review-01.md` 遗漏项与 `v23` 实际交互行为
> 结论：**需修改**（发现 1 项手动拖拽/缩放弹回 Bug 与 1 处文档事实偏差，已排入 v24 修复）

## 改动范围核对

本次为对已发布 v23 的二次复审，核验对象为 `src/core/layeredStore.ts`、`src/App.tsx` 与 `changelog/v23.md`。

## 审查发现

### 已确认正确

- `v23-review-01.md` 中记录的 6 项「已确认正确」与 3 项「非阻断问题」均与源码一致。
- `AGENTS.md` 要求的目录结构、只读历史约束与保护文件（`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts`）均保持完整。

### 非阻断问题

**1. `v23.md` 对「50 步撤销未生效」的表述与代码不符**

`src/App.tsx` 仍保留并运行着内联 50 步 `historyPastRef` 撤销/重做栈，因此撤销/重做在 v23 实际可用；真正未生效的是 `useBlueprintHistory` 抽离复用与 `useOverlaySync`（300ms 防抖 + `beforeunload` 刷盘 + `BroadcastChannel` 跨页签同步）。

- 影响面：仅文档认知偏差，不影响运行。
- 处理：不改历史 `v23.md`，在 v24 真正完成 hooks 接线并如实记录。

### 阻断问题

**1. 脚本写入 `vars.pos` / `vars.width` / `vars.title` 后，手动拖拽、缩放或编辑标题会被弹回**

`resolveEffectiveNodes()` 中 `...varDriven`（来自 `runtimeVars`）覆盖在 `...(patch ?? {})`（来自 `nodePatches`）之后，而 `App.tsx` 的 `handlePatchNode` 与 `onNodesChange` 拖拽落位路径均未清理 `runtimeVars` 中的冲突布局/形态键。点击 `pos.x +80` 或 `放大宽高` 后，再手动拖动或拉边缩放该控件会立刻被旧 `runtimeVars` 弹回。

- 影响面：全量用户，触发条件为对已由脚本控形的控件执行手动拖拽、缩放或改标题。
- 处理：记入 v24 立即修复（抽离 `clearConflictingRuntimeVars()` 并在两处手动编辑路径统一调用）。

## 验证记录

- 通过静态代码路径核对 `src/core/layeredStore.ts`（`resolveEffectiveNodes`）与 `src/App.tsx`（`handlePatchNode`、`onNodesChange`、`historyPastRef`）确认上述两项结论。
