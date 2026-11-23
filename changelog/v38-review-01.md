# v38 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v38 相对 v37 的全部改动（连线校验权下放至控件脚本）
> 结论：**可发布**，架构更通用，安全护栏（递归深度 + 超时 + 未信任脚本隔离）完好，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/scriptSandbox.ts` | 新增 `onValidateConnect` / `widgets.checkDag` / `widgets.topoSort` / `computeTopologicalOrder`，移除 `widgets.connect` 硬编码禁环 | 职责归位，信息提供与决策解耦 |
| `src/App.tsx` | 新增 `validateConnectionByWidgets()` 异步询问起点/终点控件脚本，默认允许自由连线 | 未信任外部脚本自动跳过不执行 |
| `src/core/seedBlueprint.ts` | 「③ 连线数据汇总」示例自带 `onValidateConnect` 禁环 | 直观示范控件自主校验 |
| `tests/scriptSandbox.test.ts` | 新增 2 条 `cyclePath` 与拓扑排序单测 | 27 / 27 全绿 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **环路运行安全兜底完好**：放开自由连环后，`executeUnifiedWidgetScript` 仍有 `depth > 4` 递归截断，Worker 池仍有 `5000ms` 超时强杀，不会因环路造成浏览器卡死。
- **未信任脚本不被校验钩子触发**：`validateConnectionByWidgets` 显式过滤 `untrustedScriptKeys`，外部导入未审阅的脚本不会在拖线时偷跑。
- **规范合规**：未改动任何历史 `changelog/` 文件，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：27 / 27 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-CDKXMtkO.js`（`590475` 字节）。
