# v57 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：`src/core/apiPoller.ts`、`src/canvas/ApiPollerBlock.tsx`、`src/core/mockApi.ts`、`src/core/types.ts`、`src/canvas/WidgetNode.tsx`、`src/core/widgetTemplates.ts`、`tests/apiPoller.test.ts`
> 结论：**通过**（经 75 条单测 + 9 轮真实无头 Chromium E2E 全绿验证）

## 核验要点

- **防轮询风暴与内存泄漏**：`useEffect` 仅依赖配置项并用 `ref` 隔离回调，卸载/暂停/离屏/切后台均立刻 `clearTimeout` + `abort()`，经 Chromium 实测 2 秒轮询无自激循环。
- **边缘输入安全**：URL 协议白名单、JSON 路径防原型链污染、间隔 `[2, 3600]` 夹紧、指数退避与 5 连击 Single-Flight 均经真实浏览器端到端验证通过。
