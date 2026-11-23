# v48 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v43–v47 交付物（PDF `blob:` 收敛、触屏适配、二进制代理加固、`onChange` 订阅与日志面板），以及本版补充修复
> 结论：**需修改后发布**（已在本版内修复）。上游 `v46-review-01.md` 把「`/api/proxy/binary` 已闭环」列为已修复项，但**三处加固一处都没接进路由**；同时交付物基于 v42 之前的分支，把 v42 的两处修复整体带回退了。

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/pdfHelper.ts` | v43 拒 `blob:` → v44 恢复放行，内置示例保持零 `blob:` | 最终态合理 |
| `src/canvas/PdfViewerBlock.tsx` | 移除 `createObjectURL` 降级，上传失败显式报错 | 干净 |
| `src/index.css` / `WidgetNode.tsx` / `TemplateDrawer.tsx` / `NodeInspectorPanel.tsx` | 触屏热区、选中显操作栏、小屏底部抽屉 | 仅 `pointer: coarse` 与 `<768px` 生效，桌面零回归 |
| `src/core/scriptSandbox.ts` | `onChange()` + `varsChanged` 通道 + `runChangeWatchers()` | 逻辑正确，3 轮上限需文档化（已补） |
| `src/App.tsx` | `scriptLogsByNode` 环形 50 条、`varsChanged` 派发、移动端折叠 | 干净 |
| `server/proxySecurity.ts` | 新增 `readResponseBufferWithLimit()` / `sanitizeBinaryProxyContentType()` | 函数本身正确 |
| `server/server.ts` | v46 声称接入上述函数 | **未接入**，已修 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合保护清单 |

## 阻断问题

### 1. v42 的两处修复被整体回退

交付物与 v42 提交对比，`server/proxySecurity.ts` 的 `injectSecret` 回到 `upstreamHost ? ... : ...`，`src/core/scriptAudit.ts` 消失、`ScriptTrustModal.tsx` 重新内联 `auditBlueprintScripts`。

- **密钥回落漏洞重开**：`PROXY_UPSTREAM_BASE_URL` 格式非法时 `upstreamHost` 退化为 `''`，条件为假，静默回落 `allowedHosts`，`PROXY_API_KEY` 发给 `httpbin.org`。与 v42 修复前的行为完全一致。
- **`scriptTrust.test.ts` 再次不可运行**：`import '../src/components/ScriptTrustModal.tsx'` 在无 `node_modules` 环境抛 `ERR_UNKNOWN_FILE_EXTENSION`。

判定依据：这两处不是被「改进」覆盖，而是交付物根本没包含 v42 的提交内容（`changelog/v42*.md` 也不同，说明是另一份基线）。已按原样恢复。

### 2. v46 的三处二进制代理加固，三个漏洞一个没堵

`v46-review-01.md` 的「已闭环（本次修复）」列出：

> `/api/proxy/binary` 现已与 `/api/proxy` 对齐 `redirect: 'manual'` + 3xx 拦截……
> `readResponseBufferWithLimit()` 在 `Content-Length` 预检与 `ReadableStream` 分块累加两层同时兜底……
> `sanitizeBinaryProxyContentType()` + `X-Content-Type-Options: nosniff` 阻断……

实际 `server/server.ts` 的 `/api/proxy/binary` 路由体：

```ts
const upstream = await fetch(target.url.toString(), { method: 'GET', headers, signal: controller.signal });
const arr = Buffer.from(await upstream.arrayBuffer());
if (arr.byteLength > PDF_UPLOAD_MAX_BYTES) { ... }
res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/pdf');
res.setHeader('Content-Disposition', 'inline');
```

- 无 `redirect: 'manual'` → Node `fetch` 默认跟随，白名单域名 302 到 `127.0.0.1` / `169.254.169.254` 时 SSRF 成立（路由里那轮 `dns.lookup` 只校验了原始 hostname）。
- `arrayBuffer()` 全量读入 → 读完才比大小，OOM 风险未变。
- Content-Type 直接透传 → 上游给 `text/html` 就在同源渲染。

两个函数被 `import` 进了 `server.ts` 但**没有任何调用点**，`grep -n "readResponseBufferWithLimit" server/server.ts` 只命中 import 行。

**这是「工具函数 + 单测都写好了，但没接进路由」**。原 3 条测试全在函数层，测不到接线缺失，因此「46 / 46 全绿」与漏洞存在并不矛盾。

已接入：`redirect: 'manual'` + 3xx → 502、`readResponseBufferWithLimit()`、`sanitizeBinaryProxyContentType()` + `nosniff`。

并修正一处隐蔽问题：不要把超时用的 `controller` 传给 `readResponseBufferWithLimit()`。该函数超限时自行 `abort()`，若共用 controller，`fetch` 抛 `AbortError`，外层 catch 会把「超限」误报成「代理拉取失败」（502 而非 413）。

## 非阻断问题

**`onChange()` 的 3 轮传导上限没有任何文档**

`MAX_REACTION_PASSES = 3` 是防 `a ↔ b` 死循环的硬上限。实测四级链 `a→b→c→d→e` 在 `d` 停住、`e` 保持初值，且**不报错、不提示**。用户写四级派生时会以为代码没生效。

`v47.md` 只在实现描述里提了「内置 `MAX_REACTION_PASSES = 3` 防止死循环」，`docs/SCRIPT_API_GUIDE.md` 里 `onChange` 一个字都没有。已补章节，明确写出「超过 3 轮的派生不会执行，这是上限不是 bug」。

## 已确认正确

- **`onChange` 三轮内派生完整**：`a→b→c→d` 三级链实测全部完成（1→2→3→4）。
- **池化 Worker 复用不丢订阅**：同一 worker 实例连发两次 click，两次都触发（`X:0->1`、`X:1->2`）。`runUserCode()` 重置 `changeHandlers` 后由脚本顶层重新注册，第二次进入时会重新注册，语义自洽。
- **`validateConnect` 不误跑 `onChange`**：该分支注册完 `onValidateConnect` 后立即 `postMessage` 返回，不进入 `runChangeWatchers`。
- **`'*'` 通配符跳过 `contents`**：测试断言 `wild:contents=` 不出现，防声明式 UI 重建自激。
- **`ChunkTileCache` / 触屏 CSS / PDF 协议收敛**：与 v43–v45 描述一致，逐条核对成立。

## 验证记录

交付物声称 `npm test` 49 / 49。本地无法直接复现（`node_modules` 不存在，`AGENTS.md` 禁止本地 `npm install`）。改用 Node 原生 `--experimental-strip-types` + 临时 ESM loader 实跑 10 份测试文件（临时文件跑完即删，无残留）：

| 文件 | 结果 |
| --- | --- |
| scriptSandbox + proxySecurity + layeredStore | 32 / 32 |
| chunkTileCache | 3 / 3 |
| scriptTrust | 2 / 2 |
| pdfHelper | 4 / 4 |
| chunkManager | 2 / 2 |
| crdt | 3 / 3 |
| taskList | 3 / 3 |
| viewportCulling | 3 / 3 |

合计 52 条全通过（交付物 49 + 本版新增 3）。

`onChange` 另跑 5 组探针（单次 click、链式派生、三级/四级链边界、Worker 复用两次、`validateConnect` 分支），结果均符合设计。
