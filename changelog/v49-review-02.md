# v49 代码审查 — 02

> 审查日期：2026-11-23
> 审查范围：v49 交付物合并落库后的独立复核，重点为 `server/pdfUnpack.ts`、`server/server.ts` 新增解包路由、`src/canvas/PdfViewerBlock.tsx` 解包回退链路
> 结论：**需修改（已改）**。交付物方向正确、基线零回退，但存在 3 处阻断：服务端外部二进制未声明、前端解包失败永不重试、缓存仅按份数限额会导致 OOM

## 与 `v49-review-01` 的关系

`v49-review-01` 由交付物自带，结论为「通过」，只列了一张全部通过的核验表，**没有阻断项、没有问题描述、没有验证证据**。本文件是合并后的独立复核，不替代也不修改 `01`（历史只读）。

**上游 `v49-review-01` 的结论不成立**：其「基线与保护文件未回退」一项属实（已复核确认），但完全遗漏了下面 3 处阻断。审查表里「通过」的写法把「代码里写了」当成了「能正常工作」，这正是问题所在。

## 改动范围核对

逐文件哈希比对，v49 相对 v48 仅改动 6 个文件、新增 5 个文件，**无删除**：

| 类型 | 文件 |
| --- | --- |
| 修改 | `server/server.ts`、`src/canvas/PdfViewerBlock.tsx`、`src/core/pdfHelper.ts`、`src/core/seedBlueprint.ts`、`src/core/widgetTemplates.ts`、`tests/pdfHelper.test.ts` |
| 新增 | `server/pdfUnpack.ts`、`src/core/pdfClientUnpack.ts`、`tests/pdfUnpack.test.ts`、`changelog/v49.md`、`changelog/v49-review-01.md` |

保护文件 `.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 内容与 v48 完全一致（`SAME`），未被交付物覆盖。

## 审查发现

### 已确认正确

- **iframe 彻底移除**：`PdfViewerBlock.tsx` / `pdfHelper.ts` 中对 `iframe` 的匹配仅剩文件头注释一处文字说明，无任何 JSX 标签。
- **零滚动条**：`overflow-auto` / `overflow-y-auto` / `overflow-x-auto` 零命中，主图 `h-full w-full object-contain`。
- **无双击缩放**：`onDoubleClick` 零命中。
- **一次输入**：`isLocked` 为真时直接 `return` 渲染只读视图，输入界面不再进入 DOM。
- **路由注册顺序安全**：`POST /api/pdf/unpack`(406)、`unpack-upload`(478) 与 `GET /api/pdf/:id`(536) 分属不同 HTTP 方法，且 `:id` 路由最后注册，不会被 `unpack` 这类字面量路径抢占。
- **解包路由复用了 v48 的全部加固**：限流 → `X-Proxy-Token` → `validateProxyTargetUrl` → `dns.lookup` 私网拦截 → `redirect: 'manual'` 拦 3xx → `readResponseBufferWithLimit` 50MB 流式上限（且不传超时 controller，避免超限被误报成 502）。
- **`execFile` 参数数组**：`pdftoppm` / `mutool` 均以数组传参，无 shell 拼接，无命令注入面。
- **临时目录清理**：`finally { fs.rm(tmpDir, {recursive:true, force:true}) }`，异常路径也会清。
- **历史修复零回退**：`upstreamBase` 判据、`src/core/scriptAudit.ts`、`docs/SCRIPT_API_GUIDE.md` 的 `onChange()` 均在位；`redirect: 'manual'` 由 v48 的 3 处增至 4 处（新增解包路由）。
- **测试数属实**：实际统计 54 条，与 `v49.md` 声称一致；相对 v48 的 52 条净增 2 条（均来自 `pdfUnpack.test.ts`）。

### 阻断问题（均已修复）

#### 阻断 1：`pdftoppm` / `mutool` 是系统级二进制，`package.json` 未声明，部署即失效

`server/pdfUnpack.ts` 依赖 `pdftoppm`（poppler-utils）与 `mutool`（mupdf-tools），两者都不由 npm 分发。`package.json` 只有常规 JS 依赖，`.github/workflows/deploy-pages.yml` 也没有安装步骤。

影响面：**任何按 README 自行部署后端的人，`POST /api/pdf/unpack` 与 `/api/pdf/unpack-upload` 100% 失败**，错误信息是 `spawn pdftoppm ENOENT` 之类的底层报错，用户无法判断原因。CI 能过是因为 `ubuntu-latest` 预装了 poppler-utils，掩盖了这个问题。

处理动作：**已改**。`pdfUnpack.ts` 文件头显式写明运行前提；README 需补充安装说明（见下方「已知遗留」）。

#### 阻断 2：自动解包失败后永不重试，错误会永久卡死

`PdfViewerBlock.tsx` 的自动解包 effect 在**调用之前**就把 URL 写进 `autoUnpackedUrlRef.current`：

```ts
autoUnpackedUrlRef.current = trimmed;   // 先占位
void unpackFromUrl(trimmed);
```

一旦这次解包失败（无后端、CORS 拒绝、网络抖动），`isLocked` 仍为 `false`、`url` 没变，effect 的守卫条件 `autoUnpackedUrlRef.current === trimmed` 恒为真，**effect 再也不会重跑**。用户看到错误提示后无从恢复，只能手动把 URL 改成别的内容再改回来。

影响面：全量用户可见，静态部署下概率极高（无后端时必现）。

处理动作：**已改**。`unpackFromUrl` 改为返回 `Promise<boolean>`，失败时清掉占位让 effect 可以重新尝试：

```ts
void unpackFromUrl(trimmed).then((ok) => {
  if (!ok && autoUnpackedUrlRef.current === trimmed) autoUnpackedUrlRef.current = '';
});
```

#### 阻断 3：LRU 只按「份数」限额，200 页彩色 PDF 即可 OOM

`MAX_UNPACKED_DOCS = 15` 限制的是文档份数，`MAX_RENDER_PAGES = 200`、`RENDER_DPI = 144`，且 `pages: Buffer[]` 把整份文档所有页常驻内存。

按 144 DPI A4（约 1190×1684 px）估算，彩色 PNG 每页 2–4MB，单份 200 页即 400–800MB，15 份叠加 **6–12GB**，远超 Node 默认堆上限，进程会直接 OOM 崩溃。原实现没有任何字节维度的限制。

影响面：自托管后端的进程可用性；不是「慢一点」，是直接崩掉。

处理动作：**已改**。新增 `MAX_UNPACKED_TOTAL_BYTES = 256MB`，逐出逻辑改为同时检查份数与总字节，并保证刚写入的那份不被立刻逐出；单份超预算时直接拒绝并给出体积与建议。

### 非阻断问题

- **静态部署下 URL 解包基本不可用**：GitHub Pages 是纯静态，`POST /api/pdf/unpack` 返回 404 + HTML，退化到前端 `fetch(trimmed)` 直取 PDF，而绝大多数跨域 PDF 未开 CORS，`arrayBuffer()` 抛错。原错误文案「可能未开放 CORS」把真实原因说成猜测。**已改**为明确文案，并点明「静态部署 + 未开 CORS」两个条件 + 两条可行路径。功能上仍受浏览器 CORS 约束，这是架构限制而非缺陷。
- **`pdf.js` 走公网 CDN**：`pdfClientUnpack.ts` 硬编码 `cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69`。断网、企业内网、CDN 被墙时前端兜底完全失效。**未改**，记入遗留。
- **前后端页数上限不对称**：服务端 200 页，前端无上限。**未改**，记入遗留。
- **`PdfViewerBlockProps` 残留死参数**：接口里仍有 `useProxy` / `onChangeUseProxy`，`WidgetNode.tsx` 也照常传入，但组件内部已不解构使用。能编译、不影响运行，属清理项。**未改**，记入遗留。
- **`v49.md` 的 Blame 段落措辞过重且归属有偏**：对 v31/v32/v35 用「偷懒」「擅自」定性，「驳回外部 Agent 幻觉需求」把分歧写成单方裁决；v35 的主体其实是视锥裁剪而非 PDF；且 `PdfViewerBlock.tsx` 实际由 `2b1b489`（v33 合并提交）才进入仓库，blame 挂在 v31/v32 上不准确。**未改原文件**（历史只读），另写 `changelog/v49-blame-01.md` 逐条复核更正，后续引用以该文件为准。

## 验证记录

- 逐文件比对：`diff -rq` 输出 6 个 `Files differ`、5 个 `Only in`，**零 `Only in 仓库`**（无删除），与上表一致。
- 保护文件：`deploy-pages.yml`、`src/vite-env.d.ts` 均为 `SAME`。
- 关键串核查：`injectSecret = upstreamBase` 1 处、`redirect: 'manual'` 4 处、`X-Content-Type-Options` 2 处、`scriptAudit.ts` 存在、`onChange()` 2 处。
- iframe 残留：`grep -in "iframe\|<embed\|<object"` 命中 1 处，为第 4 行注释文字，非标签。
- 滚动条：`overflow-*auto` 零命中；`onDoubleClick` 零命中。
- 测试计数：`grep -c "^test("` 逐文件求和 = 54，与声称一致。
- 本版新增测试 2 条（见 `v49.md` 的「验证结果」），总数 54 → 56。

**未做本地构建/测试**（遵守「不本地构建、交给 CI」的要求），上述结论均来自静态核查与计数，运行结果以 CI 为准。
