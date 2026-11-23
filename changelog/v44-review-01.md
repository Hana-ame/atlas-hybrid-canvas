# v44 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v44 相对 v43 的全部改动（恢复 `blob:` 协议放行、保持示例零 `blob:`）
> 结论：**可发布**，协议边界与示例洁净度兼得，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/pdfHelper.ts` / `PdfViewerBlock.tsx` / `tests/pdfHelper.test.ts` | 恢复放行 `blob:`，不恢复演示 `blob:` 生成器 | 精准最小改动 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- 内置示例与模板中零 `blob:` / `createObjectURL` 用法；危险协议（`javascript:` / `data:text/html`）仍严格拦截。
- 历史 `changelog/` 文件只读未动，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：43 / 43 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-D_GDcSsm.js`（`590619` 字节）。
