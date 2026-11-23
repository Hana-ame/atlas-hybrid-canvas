# v43 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v43 相对 v42 的全部改动（彻底移除 PDF `blob:` 模式）
> 结论：**可发布**，PDF 链路不再产生跨会话失效的 `blob:` 死链，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/pdfHelper.ts` | 移除 `blob:` 放行与 `createDemoSamplePdfBlobUrl()` | 协议收敛干净 |
| `src/canvas/PdfViewerBlock.tsx` | 去掉所有 `createObjectURL` 降级与演示 Blob 按钮，上传直连 `/api/pdf/upload` | 失败显式提示、零静默假成功 |
| `tests/pdfHelper.test.ts` | 断言 `blob:` 被拒绝 | 43 / 43 全绿 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- 全仓 PDF 模块已无 `URL.createObjectURL` / `blob:` 生成路径；历史缓存中残留的旧 `blob:` 仍由 `sanitizeEphemeralBlobVars()` 启动自动清空。
- 历史 `changelog/` 文件只读未动，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：43 / 43 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-BWkrVm_5.js`（`590586` 字节）。
