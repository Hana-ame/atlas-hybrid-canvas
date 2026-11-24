# v84 代码审查 — 01（全量问题复核与整修确认报告）

> 审查日期：2026-11-24
> 审查对象：逐条复核 `v82-review-01.md`、`v82-review-02.md` 与 `audit-2026-11-24-全仓库.md` 指出的全部 P0/P1/P2/P3 问题
> 结论：**大部分问题全部成立（已逐行核实），需立即在 v85 整修**；仅 2 项属于明确的产品/Beta 架构取舍（在报告中明确界定边界）。

## 一、P0 / P1 高危问题逐条复核

| 编号 | 来源 | 问题摘要 | 核实结果 | 处置结论 |
| :--- | :--- | :--- | :--- | :--- |
| P0-1 | `v82-review-01` | `POST /api/auth/session` 在 `Origin` 为空时短路放行，无头 `curl` 可直接签发 1 小时签名令牌（`server/server.ts:335`） | **成立（确认真 Bug）** | 必须在 v85 修复：空 `Origin` 直接 403，且补 E2E 负向用例 |
| P0-2 | `v82-review-01` | `Origin` 本身是客户端可控头，CORS 白名单对非浏览器脚本不构成认证边界 | **成立（架构边界说明）** | 按 Beta 匿名协同定位：前端零静态密钥，会话令牌仅作防自动化/限流层；真正的高危能力（`/api/proxy` 上游密钥、发布、回档）必须与匿名会话令牌解耦（见 P1-2） |
| P1-1 | `v82-review-01` | `roomServer.ts:511` 无条件信任 `X-Forwarded-For` 并透传为限流键，伪造头可绕过 `PROXY_RATE_LIMIT_PER_MIN` 或污染他人限流桶 | **成立（确认真漏洞）** | 必须在 v85 修复：仅在显式 `TRUST_PROXY=true` 时读取 XFF，否则强制使用 `req.socket.remoteAddress`，并补 E2E 429 回归测试 |
| P1-2 | `v82-review-01` | `/api/proxy` 与匿名会话令牌共用鉴权，导致匿名会话可借用服务端 `PROXY_API_KEY` | **成立（确认真漏洞）** | 必须在 v85 修复：新增 `PROXY_ACCESS_KEY`；配置 `PROXY_ACCESS_KEY` 或 `PROXY_API_KEY` 时拒绝仅凭匿名会话调用 `/api/proxy`，必须提供管理密钥 |
| P1-3 | `v82-review-01` | 浏览器静态模式 `mockApi.ts` 未注入 `getRoomStore`，所有房间共用同一份 IndexedDB 蓝图 | **成立（确认功能缺失）** | 必须在 v85 修复：在 `mockApi.ts` 实现按 `roomPath` 隔离的 `createBrowserRoomStore` 并注入 `browserDeps.getRoomStore` |
| P1-A | `audit-2026-11-24` | `scriptSandbox.ts` 运行时置空列表漏掉 `Worker`/`SharedWorker`/`Blob`/`URL`/`WebTransport`/`WebAssembly`，存在嵌套 Worker 逃逸路径；且 `AGENTS.md` 误把词法黑名单称为安全边界 | **成立（确认真漏洞）** | 必须在 v85 修复：补全 6 个高危 API 至运行时置空列表、修正 `AGENTS.md` 表述、补逃逸负向测试 |

## 二、P2 / P3 问题逐条复核

| 编号 | 来源 | 问题摘要 | 核实结果 | 处置结论 |
| :--- | :--- | :--- | :--- | :--- |
| P2-1 | `v82-review-01` | WebRTC P2P 帧绕过服务端，不作为安全边界 | **成立（设计定位）** | 保持双发（P2P 低延迟加速 + WS 落盘与服务端权威），不依赖 P2P 做安全边界 |
| P2-2 | `v82-review-01` | `fileStore.ts` 保留 4 个零生产引用的死导出（`sanitizeRoomFileKey` 等） | **成立** | v85 删除全部死代码，并将 `tests/fileStore.test.ts` 改为直接测生产 `createRoomBlueprintStoreRegistry` |
| P2-3 | `v82-review-01` | `server.ts:614` 过期 `PROXY_CLIENT_TOKEN` 注释、`isBinaryRoute` 未使用、`vite-env.d.ts` 残留 `VITE_PROXY_CLIENT_TOKEN` | **成立** | v85 全部清理 |
| P2-4 | `v82-review-01` | `listPersistedRooms` 返回带哈希的文件键而非人类可读的逻辑 `roomPath` | **成立** | v85 在房间 JSON 内持久化 `roomPath`，`listPersistedRooms` 优先返回逻辑路径 |
| P2-A | `v82-review-02` | 跨源部署下 `<img>` 受 `SameSite=Strict` 限制无法携带 Cookie，且 `appendProxyTokenQuery` 已为空实现 | **成立（跨源部署已知限制）** | 同源/纯静态无影响；跨源 PDF 图片需由后端改为短时效签名 URL（记为后续规划，不回退到长期 URL bearer） |
| P2-B | `v82-review-02` | `PdfViewerBlock` 卸载时未调用 `disposeClientPdfDoc` | **成立** | v85 补 `useEffect` 卸载清理 |
| P3-B | `audit-2026-11-24` | PDF 解包失败将内部 `err.message`（含宿主机命令/路径）直接回传客户端 | **成立** | v85 改为服务端打日志、客户端返回通用错误文案 |
| P3-C | `audit-2026-11-24` | 浏览器侧 `browserFetcher` 无 2MB 响应体上限 | **成立** | v85 补齐与服务端一致的 2MB 上限 |
| P3-3 | `v82-review-01` | `roomClient.ts` 的 `recentFrames` 清理逻辑在迭代中依赖 `size` | **成立** | v85 拆分为「先删过期、再按 FIFO 截断到 256」两步 |
| P3-4 | `v82-review-01` | `/api/proxy` 与 `/api/proxy/binary` 鉴权三重冗余 | **成立** | v85 收口为单一 `/api/proxy` 中间件 |
| P3-5 | `v82-review-01` | `App.tsx` 的 `loadRoomHistory` 缺少竞态序号保护 | **成立** | v85 补 `historyReqSeqRef` 防旧响应覆盖 |
| P3-7 | `v82-review-01` | `layeredStore.ts` 跨页签过滤放行无 `storageKey` 广播 | **成立** | v85 收紧为严格相等校验 |
| P3-A/B/C/D/E | `v82-review-02` | `proxy_http` 未检查 `resp.ok`、`renderedScriptsRef` 声明顺序、`useOverlaySync` 双 effect 顺序依赖、`SliderControlBlock` 任意按键提交、`AnnotationNode` `imageUrlDraft` 不同步 | **全部成立** | v85 一次性全部修复 |
