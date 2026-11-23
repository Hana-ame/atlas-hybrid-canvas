# v49 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：基于用户最新 v48 基线的 v49 PDF 逐页解包重构（`server/pdfUnpack.ts`、`server/server.ts`、`src/core/pdfHelper.ts`、`src/core/pdfClientUnpack.ts`、`src/canvas/PdfViewerBlock.tsx`、`tests/pdfUnpack.test.ts`）
> 结论：**通过**，全部需求严格对齐，保护清单与历史基线零回退。

## 需求逐项核验

| 核验项 | 实测结果 |
| --- | --- |
| 彻底移除浏览器内置 `<iframe>` PDF 阅读器 | 通过：`PdfViewerBlock.tsx` 无任何 `<iframe>` / `<embed>` / `<object>`，`pdfHelper.ts` 已删除 `buildPdfIframeSrc()` |
| 解包 PDF 为逐页图片 | 通过：服务端 `pdftoppm`/`mutool` 输出逐页 PNG（`tests/pdfUnpack.test.ts` 实测校验 PNG 魔数 `89 50 4E 47`），静态模式前端 `pdf.js` 离屏 Canvas 转 PNG |
| 严格 fit 控件大小、无双击放大 | 通过：主图 `className="h-full w-full object-contain"`，随控件宽高自动缩放，无 `onDoubleClick` 缩放状态 |
| 零滚动条、仅左右翻页与页码 | 通过：外层与视口均为 `overflow-hidden`，无任何 `overflow-auto`/`overflow-y-auto`，仅保留左右箭头与底部页码栏 |
| URL 输入为一次性 | 通过：解包锁定后 `isLocked === true` 永久隐藏输入界面，无「换源」按钮 |
| Blame 历史幻觉/错误版本 | 通过：`v49.md` 已明确点名追责 `v31`/`v32`/`v35` 并记录驳回幻觉需求 |
| v42/v48 基线与保护文件未回退 | 通过：`upstreamBase`、`src/core/scriptAudit.ts`、`/api/proxy/binary` 接线、`docs/SCRIPT_API_GUIDE.md`、`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 全部完好 |
