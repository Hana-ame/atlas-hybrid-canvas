# v26 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v26 相对 v25 的全部改动
> 结论：**可发布**，首屏脚本渲染竞态根因明确且已闭环，界面清理无回归

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/App.tsx` | 首帧脚本等待 `overlayHydrated`、隐藏 `Controls` 锁、常驻提示改为 3.5s 自动收起 Notify | 精准修复 3 项真机反馈问题 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **竞态根因彻底消除**：`overlayHydrated` 仅在 `loadLocalOverlay()` + 远端蓝图拉取完成后置为 `true`，确保首帧脚本产出 `vars.contents` 不会被初始化 `setOverlay` 冲掉。
- **浮动 Notify 生命周期干净**：新消息到来时重置 `3500ms` 定时器，组件卸载时自动 `clearTimeout`，空闲态不挂载 DOM 节点。
- **规范合规**：历史 `changelog/` 文件只读未动，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：17 / 17 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-BlH7jqiG.js`（`567256` 字节）。
