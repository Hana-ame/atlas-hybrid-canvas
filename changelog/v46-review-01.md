# v46 Review 01 — 历史 16 项隐患复核与 `/api/proxy/binary` 安全回归评审

## 评审范围
- 逐条复核历史粘贴的 16 项架构/安全/性能隐患在当前代码库中的真实落地状态。
- 重点审计 `server/server.ts`、`server/proxySecurity.ts` 及新增单测 `tests/proxySecurity.test.ts`。

## 评审结论
- **已闭环（本次修复）**：
  - `/api/proxy/binary` 现已与 `/api/proxy` 对齐 `redirect: 'manual'` + 3xx 拦截，消除通过白名单域名 302 跳转至内网/元数据服务的 SSRF 路径。
  - `readResponseBufferWithLimit()` 在 `Content-Length` 预检与 `ReadableStream` 分块累加两层同时兜底，超限时主动 `abort()` 并取消流，避免大文件缓冲撑爆内存。
  - `sanitizeBinaryProxyContentType()` + `X-Content-Type-Options: nosniff` 阻断上游伪造 `text/html` / `image/svg+xml` 在同源内联渲染触发 XSS。
- **仍留待后续演进的已知架构项（明确记录，未做破坏性大改）**：
  - `src/App.tsx` 当前 2,165 行，仍需继续拆分脚本调度/协同连接/顶栏子模块。
  - `entity.buttons` 与 `entity.script + vars.contents` 仍双轨并存。
  - `useBlueprintHistory.ts` 仍为全量深拷贝快照（最多 50 步），未升级为节点级 patch diff。
  - `dns.lookup` 与 `fetch` 之间仍存在理论 DNS Rebinding 窗口。
  - `NodeInspectorPanel.tsx` 编辑器已有语法错误提示，但尚无行号高亮与独立按节点日志面板；`scriptSandbox.ts` 静态检查仍为词法/子串黑名单而非 AST；尚无 Playwright E2E 与变量级 `onChange(key, fn)`。
