# v52 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：以 `51.zip` 为基准合并 v50/v51 PDF 体验升级的全部改动
> 结论：**通过**

## 合并完整性核对

| 核对项 | 状态 |
| --- | --- |
| 保留 `51.zip` 的 `server/roomServer.ts`、`src/core/apiCore.ts`、`apiClient.ts`、`rpcClient.ts`、`runtimeConfig.ts` | 通过，原样保留 |
| 保留 `51.zip` `PdfViewerBlock.tsx` 中的 `proxyHeaders(...)` 鉴权头注入 | 通过，`/api/pdf/unpack` 与 `/api/pdf/unpack-upload` 均已保留 |
| 保留 `51.zip` `server/pdfUnpack.ts` 中的 `MAX_UNPACKED_TOTAL_BYTES = 256MB` 防 OOM 逐出 | 通过，按原 PDF 字节 + 页图缓存字节实时计账并全局 LRU 逐出 |
| 保留 `51.zip` 全部历史 changelog（`v50.md`、`v51.md`、`v49-blame-01.md` 等）与保护清单文件 | 通过，零覆盖 |
| 新合并功能（输入可点击、多 DPI 防发糊、整卡拖拽、预加载零闪烁） | 通过，67/67 可运行单测与 `vite build` 全绿 |
