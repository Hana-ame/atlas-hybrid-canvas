# v33 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v31 + v32 交付物全部改动（PDF 阅读控件、服务端二进制代理与上传托管、沉浸式布局），以及本版回补的 v30 扇出补丁
> 结论：**需修改后发布**（已在本版内修复）。上游 `v31-review-01.md` / `v32-review-01.md` 均判「可发布、无阻断问题」，**不成立**——两份审查都没发现交付物整体回退了 v30 的扇出修复，也没发现 PDF 上传的边界撞车。

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/canvas/PdfViewerBlock.tsx` | 新增，332 行，沉浸式满铺 + 底部翻页胶囊 | 布局逻辑清晰，无 `dangerouslySetInnerHTML` |
| `src/core/pdfHelper.ts` | 新增，URL 白名单 + 页码钳位 + 页数解析 | 白名单实测可靠；页数解析有已知局限 |
| `src/core/types.ts` / `widgetTemplates.ts` | 新增 `pdf` 块类型与 `tpl-pdf-reader` 模板 | 模板脚本通过安全预检 |
| `src/canvas/WidgetNode.tsx` | 单 PDF 块零 padding 满铺分支 | `isImmersivePdf` 判定严格（长度 1 且非数组），普通卡片零影响 |
| `server/server.ts` | `/api/proxy/binary`、`/api/pdf/upload`、`/api/pdf/:id` | 存在 2 处实质缺陷，已修 |
| `src/App.tsx` / `scriptSandbox.ts` / `seedBlueprint.ts` | 交付物回到 v29 状态，v30 扇出补丁丢失 | 已回补 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 交付物为旧版 | 按保护清单保留仓库维护版，未覆盖 |

## 审查发现

### 已确认正确

- **URL 白名单可靠**：`isSafePdfUrl()` 用 `new URL()` 解析后只放行 `http:` / `https:`，实测 `javascript:`、`data:`、`vbscript:`、`file:`、大小写变体 `JaVaScRiPt:`、前后空格变体全部正确拦截。`blob:` 与 `/api/pdf/`、`/api/proxy/binary` 前缀按设计放行。
- **页码钳位完整**：`normalizePdfPage()` 对 `NaN`、负数、非有限值回退到 1，上限 9999；`commitPage` 在 `totalPages` 已知时再钳到 `[1, totalPages]`，首末页分别禁用 `‹` / `›` 按钮。
- **SSRF 防护到位**：`/api/proxy/binary` 复用了白名单校验 + `dns.lookup` 全量解析 + `isPrivateOrReservedIP` 私有地址拦截，且带 `AbortController` 超时。
- **上传魔数校验存在**：`/api/pdf/upload` 校验 `%PDF` 头（`buf.subarray(0,4)`），非 PDF 直接 400。
- **文件名已消毒**：`replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)`，无路径穿越风险。
- **iframe 无 `dangerouslySetInnerHTML`**：PDF 一律走 `<iframe src>` 渲染，不存在把 PDF 字节注入 DOM 的路径。
- **`isImmersivePdf` 判定严格**：要求 `flowItems.length === 1 && !Array.isArray(flowItems[0]) && type === 'pdf'`，多块卡片不会误入满铺分支。

### 非阻断问题

1. **`/api/pdf/:id` 无鉴权读取**
   - 影响面：自托管场景；静态 Pages 部署不受影响（无此后端）。
   - 内容：id 为 `crypto.randomBytes(8)` 十六进制（16 字符），不可枚举；但链接一旦经日志/截图/分享泄漏，任何人可读。
   - 处理动作：**未改**。按「随机不可猜 URL」的设计取舍，加 token 会破坏 iframe 直接嵌入的便利性。记入已知遗留。

2. **`widgets.connect()` 仍绕过 `validateDagConnection()`**
   - 影响面：脚本内建边不受 DAG 校验，违反 `AGENTS.md` 明文约定。
   - 处理动作：**未改**。v30 审查已记录，v31/v32 未处理，本版合并范围内未涉及。风险由 `depth > 4` 递归护栏兜底，不会无限递归。

3. **压缩流 PDF 页数统计失效**
   - 影响面：绝大多数真实 PDF 用 FlateDecode 压缩页对象，`countPdfPagesFromBytes` 扫不到，返回 `null` 显示「共 ? 页」。
   - 处理动作：**部分改进**。匹配窗口从 240B 放宽到 4KB，提升未压缩/半压缩 PDF 命中率；并在函数注释写明根本局限，避免误以为能覆盖全部。彻底解决需引入 PDF 解析库，未做。

### 阻断问题

1. **交付物整体回退了 v30 扇出修复**（已在 v33 回补）
   - 位置：`src/App.tsx`、`src/core/scriptSandbox.ts`、`src/core/seedBlueprint.ts`。
   - 影响面：全量用户可见。
   - 成因：v31/v32 交付物基于 **v29** 另起一条线，仓库 v30 的扇出修复未随交付物携带（`mergedEmits` / `uniqueOutputs` / `targetIds` 三处标记在交付物中均为 0）。
   - 后果：重新回到 v30 修复前的缺陷状态——多下游并发时同一脚本被多个 Worker 同时执行、`setOverlay` 后写者覆盖前写者导致丢更新；`emitDownstream` 的 `count` 因按边计数而虚高、接收方被同一消息重复触发。
   - 修复：三处补丁重新打上，补齐 `handleRunButton` 里新出现的同款缺失去重（v30 时该函数还不存在）。

2. **PDF 上传 15MB 边界撞车**（已在 v33 修复）
   - 位置：`server/server.ts` `express.json({ limit: '20mb' })` 与 `/api/pdf/upload` 的 15MB 校验。
   - 影响面：自托管用户上传接近上限的文件时直接失败。
   - 成因：base64 编码膨胀 4/3，15MB 原始字节编码后**恰好 20.00MB**，再加 JSON 字段包装必然超过 `20mb` 的 limit。express 在进入路由前就 `413 PayloadTooLarge`，用户看到的是 express 默认错误页，而不是代码里精心写的「PDF 文件大小需在 1B–15MB 之间」。
   - 修复：limit 抬到 `24mb`，给 JSON 包装与字段名留出余量。

3. **PDF 存储淘汰不是 LRU**（已在 v33 修复）
   - 位置：`/api/pdf/:id` 读取接口与 `MAX_UPLOADED_PDFS = 20` 的淘汰逻辑。
   - 影响面：自托管用户——频繁回看的文档反而最先被淘汰。
   - 成因：`Map` 按插入顺序迭代，`get()` 不改变顺序。代码注释写的是「内存 LRU」，实际淘汰的是**最早上传**的那份（FIFO）。
   - 修复：命中时 `delete` + `set` 把该项移到队尾，恢复真正 LRU。

## 验证记录

- **种子脚本**：5 / 5 通过 26 token 黑名单 + `AsyncFunction` 编译。
- **模板脚本**：3 / 3 通过（含 `String.raw` 的 PDF 模板）。
- **URL 白名单实测**：10 个用例（含 `javascript:`、`data:`、`vbscript:`、`file:`、大小写与空格变体）判定全部正确。
- **页数解析实测**：demo → 3；400B 间隔 → 7；3KB 间隔 → 12；压缩流 → `null`（优雅降级）。
- **base64 边界算术**：`15MB × 4/3 = 20.00MB`，确认原 `20mb` limit 必然拒绝。
- **补丁就位**：`mergedEmits` 8 处、`uniqueOutputs` 3 处、`targetIds` 5 处、池注释 1 处。
- **改动范围**：`git status` 仅 8 个修改文件 + 6 个新增文件，未触及 `vite.config.ts`、`package.json`、`AGENTS.md`。
- **保护文件**：`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 交付物为旧版，已保留仓库维护版。
- **版本号**：交付物自带 v31/v32 记录，与仓库既有 v29/v30 无编号冲突，直接沿用；本版合并补丁记为 v33。
- `npm test` / `npm run typecheck` / `npm run build`：由 CI 执行，本机不跑（`AGENTS.md` 禁止本地构建）。
