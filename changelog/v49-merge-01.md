# v49 合并说明 — 落库记录

> 合并日期：2026-11-23
> 来源：`atlas-hybrid-canvas-v49.zip`（单层包，根目录即项目根）
> 基线：`ea24b88`（v48）
> 说明：本文件记录 v49 交付物落库时的取舍。`v49.md` 与 `v49-review-01.md` 为交付物自带、原样保留，不在本文中修改。

## 落库范围

相对 `ea24b88` 共 11 个文件，**无删除**：

**修改 6 个**
- `server/server.ts` — 新增 `POST /api/pdf/unpack`、`POST /api/pdf/unpack-upload`、`GET /api/pdf/:id/meta`、`GET /api/pdf/:id/page/:page`
- `src/canvas/PdfViewerBlock.tsx` — iframe 全量替换为单页 `<img>`，一次性输入态 + 仿 Windows 图片查看器布局
- `src/core/pdfHelper.ts` — 删 `buildPdfIframeSrc()`，增 `isUnpackedPdfTemplate()` / `buildPdfPageImageUrl()`
- `src/core/seedBlueprint.ts`、`src/core/widgetTemplates.ts` — 控件标题与描述同步
- `tests/pdfHelper.test.ts` — iframe 用例替换为逐页图片用例

**新增 5 个**
- `server/pdfUnpack.ts` — 服务端光栅化解包引擎
- `src/core/pdfClientUnpack.ts` — 前端 pdf.js 兜底解包
- `tests/pdfUnpack.test.ts` — 解包链路测试
- `changelog/v49.md`、`changelog/v49-review-01.md` — 交付物自带的版本与审查记录

**保护文件未动**：`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 与 v48 内容一致。

## 相对交付物的修改

交付物存在 3 处阻断与 1 处文案问题，已在本仓库修复，详见 `changelog/v49-review-02.md`。

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `server/pdfUnpack.ts` | 新增 `MAX_UNPACKED_TOTAL_BYTES = 256MB` 总字节上限，逐出逻辑改为份数 + 字节双重限额；单份超预算直接拒绝 |
| 2 | `server/pdfUnpack.ts` | 文件头写明依赖 `pdftoppm`（poppler-utils）或 `mutool`（mupdf-tools），二者无法经 npm 安装 |
| 3 | `src/canvas/PdfViewerBlock.tsx` | `unpackFromUrl` 改返回 `Promise<boolean>`；自动解包失败时清空 `autoUnpackedUrlRef` 占位，使 effect 可重试（原实现失败后永久卡死） |
| 4 | `src/canvas/PdfViewerBlock.tsx` | 静态部署下的回退错误文案改为点明「静态部署 + 未开 CORS」两个条件，并给出两条可行路径 |
| 5 | `src/canvas/PdfViewerBlock.tsx` | 上传路径的 `resp.status !== 404` 判断改为 `data?.error` 判断，与服务端错误语义对齐 |
| 6 | `tests/pdfUnpack.test.ts` | 新增 2 条：不存在 docId / 非法页码返回 null 不崩；非 PDF 与空 Buffer 必须拒绝 |

## 已知遗留

- **后端需宿主提供 poppler-utils 或 mupdf-tools**。`package.json` 无法声明，README 尚未补充安装说明。CI 因 `ubuntu-latest` 预装 poppler 而掩盖此依赖。
- **静态部署（GitHub Pages）下 URL 解包受浏览器 CORS 约束**。纯静态无后端，只能退化到前端 pdf.js 直取字节；目标 PDF 未开 CORS 时不可用，此时应改用本地文件选择。
- **前端 pdf.js 依赖公网 CDN**（`cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69`）。断网、内网、CDN 不可达时前端兜底失效。
- **前后端页数上限不对称**：服务端 `MAX_RENDER_PAGES = 200`，前端无上限，超长文档两端行为不一致。
- **`PdfViewerBlockProps` 残留 `useProxy` / `onChangeUseProxy`**：组件已不解构使用，`WidgetNode.tsx` 仍在传入，可编译但属死参数。
- **`v49.md` 的 Blame 段落措辞过重**（「偷懒」「擅自」「幻觉」），属表述问题，不影响功能；历史文件只读，不回头改。
