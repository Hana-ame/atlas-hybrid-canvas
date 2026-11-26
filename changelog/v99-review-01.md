# v99 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：相对 `fe18be0`（v98）的全部改动
> 结论：**可发布**（无阻断；保持原有静态/公网默认安全策略，仅在显式配置或 Docker 构建期关闭强制后端代理）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 配置与类型 | `src/vite-env.d.ts`、`src/core/runtimeConfig.ts`、`src/core/types.ts` | 新增 `VITE_FORCE_BACKEND_PROXY`、`useProxy`、`proxyBody` |
| 请求执行与 UI | `src/core/httpButton.ts`、`src/core/apiPoller.ts`、`src/canvas/ApiPollerBlock.tsx`、`src/canvas/contentBlockRegistry.tsx`、`src/core/widgetTemplates.ts`、`src/components/NodeInspectorPanel.tsx`、`src/App.tsx` | 同源 `/`（非 `//`）与 CORS 直连可配；非 `/api/` 请求不附带会话令牌 |
| 服务端代理 | `server/proxySecurity.ts`、`src/core/apiCore.ts` | 支持 `*` 放行公网域名，不放开私网 SSRF 且不向通配目标注入上游密钥 |
| Docker 与测试 | `Dockerfile`、`.env.example`、`tests/apiPoller.test.ts`、`tests/coreTransports.test.ts`、`tests/apiCore.test.ts` | Docker 默认 `VITE_FORCE_BACKEND_PROXY=false` |

## 审查发现

### 已确认正确

1. **安全边界未静默降级**：`parseForceBackendProxy()` 缺省返回 `true`，非 Docker 独立构建与 GitHub Pages 行为不变；Docker 中通过构建参数显式设为 `false`。
2. **协议与路径注入防护保留**：`isSafePollUrl()` 拒绝 `//`（防止 protocol-relative 开放重定向）以及 `javascript:` / `data:` / `file:`；直连 `fetch` 仅对 `/api/` 前缀附带 `proxyHeaders()`，避免将 `X-Proxy-Token` 泄露给外部 CORS 服务或同域其他应用。
3. **通配符 `*` 不泄露上游密钥**：`server/proxySecurity.ts` 对 `injectSecret` 过滤掉 `allowed === '*'`，即便配置 `PROXY_ALLOWED_HOSTS=*` 且未配置 `PROXY_UPSTREAM_BASE_URL` 也不会向任意第三方注入 `PROXY_API_KEY`，且 `isPrivateOrReservedIP` 仍拦截内网地址。

### 非阻断问题

1. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`，该文件交由 CI 与 Docker 内环境验证。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build:server`、`npm run build:mcp`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，196/196 通过。
