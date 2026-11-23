# v34 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v34 相对 v33 的全部改动（PDF 上传由 base64 JSON 改为二进制直传，上限放宽至 50MB）
> 结论：**可发布**。改动集中、边界清楚，同时修掉了两个原有缺陷（上传失败无提示、413 暴露 Express 默认页）。

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `server/server.ts` | 新增 `PDF_UPLOAD_MAX_BYTES`/`PDF_UPLOAD_MAX_LABEL` 常量；`express.json` limit 24mb→1mb；新增 `express.raw` 中间件；上传路由改读 Buffer；代理上限引用同一常量；新增兜底错误中间件 | 范围符合需求，无越界改动 |
| `src/canvas/PdfViewerBlock.tsx` | 移除 `FileReader`+base64，改 `body: file` 直传；上限 12MB→50MB；新增失败提示；上传按钮 title 补上限 | 同上 |
| `package.json` | 未新增依赖 | `express.raw` 为 Express 4 内置 |

## 审查发现

### 已确认正确

- **Content-Type 精确匹配**：`express.raw({ type: 'application/pdf' })` 只对 PDF 类型生效，不会误吞 blueprint 等 JSON 请求体；`express.json` 与 `express.raw` 按路径前缀分流，无中间件互相干扰。
- **魔数与大小校验保留**：改二进制后仍校验 `%PDF` 头（`buf.subarray(0,4)`）与 `PDF_UPLOAD_MAX_BYTES`，安全边界没有因为改传输方式而退化。
- **文件名消毒保留**：`replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)` 仍在，且新增 `|| 'document.pdf'` 兜底，防止 `decodeURIComponent` 后变成空串。
- **`X-Pdf-Filename` 解码有保护**：`decodeURIComponent` 包在 try/catch 里，未编码的原始头值不会抛错。
- **LRU 语义未被破坏**：v33 修好的 `delete`+`set` 命中刷新逻辑保持原样。
- **中间件顺序正确**：兜底错误中间件注册在 `app.use(express.static)` 与 SPA 通配路由之后，只兜底未被处理的错误；`res.headersSent` 时 `next(err)` 透传给 Express 默认处理，避免二次写入响应。
- **前后端阈值同源**：服务端常量、前端 `file.size` 判断、按钮 title 三处一致，无漂移。

### 非阻断问题

1. **`express.raw` 的 limit 与路由内校验重复**
   - 影响面：无功能影响，属冗余。
   - 内容：超限请求会先被 `express.raw` 拦下走到兜底中间件，路由内的 `buf.byteLength > PDF_UPLOAD_MAX_BYTES` 实际只可能对「Content-Type 非 application/pdf 但 body 被其他中间件解析」的极端情况生效。
   - 处理动作：**保留**。两层校验的成本可忽略，但能防止将来有人调整中间件顺序时失去兜底。

2. **大文件走内存**
   - 影响面：自托管场景，50MB × 并发上传数。
   - 内容：`express.raw` 与 `uploadedPdfStore` 都是内存持有，`MAX_UPLOADED_PDFS = 20` 意味着理论上限 20 × 50MB = 1GB 常驻。
   - 处理动作：**未改**。原设计即内存 LRU，若要上生产应换磁盘/对象存储。记入已知遗留。

3. **前端 50MB 判断与服务端不完全等价**
   - 影响面：无。
   - 内容：前端用 `file.size <= 50 * 1024 * 1024`，服务端用 `buf.byteLength > PDF_UPLOAD_MAX_BYTES` 拒绝，边界处恰好 50MB 的文件两边都放行，语义一致。
   - 处理动作：**无需处理**，确认一致。

### 阻断问题

无。

## 验证记录

- **base64 残留清查**：`grep -rn "base64\|readAsDataURL\|FileReader" src/ server/` 在 PDF 路径上仅剩注释；另两处命中属背景图上传，未在本次范围内。
- **语法检查**：`node --experimental-strip-types --check` 对 `server/server.ts`、`src/core/pdfHelper.ts` 均通过（无输出）；`server.ts` 括号平衡脚本校验 OK。
- **依赖**：`express@^4.21.2`、`@types/express@^4.17.21`，`express.raw` 属 4.16+ 标准 API，零新增依赖。
- **改动行数**：`server.ts +71/-28`、`PdfViewerBlock.tsx` 同步调整，共 2 个文件。
- **保护文件**：`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 未触及。
- `npm test` / `npm run typecheck` / `npm run build`：由 CI 执行，本机不跑（`AGENTS.md` 禁止本地构建）。
