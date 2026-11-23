# v41 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v41 相对 v40 的全部改动（测试覆盖补齐 + `proxySecurity.ts` 密钥注入边界修复）
> 结论：**可发布**，新增单测成功捕获并闭环了 1 处高危密钥泄漏漏洞，42 / 42 全绿，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `server/proxySecurity.ts` | 收紧 `injectSecret`：配置 `upstreamBaseUrl` 时仅对 `upstreamHost` 注入密钥 | 堵住向 `httpbin.org` 等第三方白名单主机泄漏 `PROXY_API_KEY` 的风险 |
| `tests/chunkTileCache.test.ts` / `scriptTrust.test.ts` | 新增 5 条缓存 LRU 与脚本审计门禁测试 | 填补核心模块 0 覆盖空白 |
| `tests/scriptSandbox.test.ts` / `layeredStore.test.ts` / `proxySecurity.test.ts` | 新增 8 条真实 Worker 执行、存储合并与 SSRF 边界测试 | 总用例 29 → 42 全绿 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **密钥注入边界严密**：配置 `upstreamBaseUrl` 时，仅同源上游收到 `PROXY_API_KEY`；第三方白名单主机仍可代理但不带密钥。未配置 `upstreamBaseUrl` 时保持原有 `allowedHosts` 兼容语义。
- **Worker 沙箱直测有效**：`runWorkerBootstrapInNode` 直接执行生产 `workerBootstrap`，不再只测外围辅助函数。
- **规范合规**：严格遵循 `AGENTS.md`，历史 `changelog/` 文件只读未动，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：42 / 42 全部通过（10 份测试文件）。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-Rgt91NEo.js`（`591558` 字节）。
