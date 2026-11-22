# 后端接口契约、保存鉴权与安全说明

本项目采用“前后端契约一致、开发/生产真后端 + 静态站 Mock 自动切换”的设计。

## 一、环境变量配置（`.env`）

| 变量名 | 用途 | 默认值 / 说明 |
| --- | --- | --- |
| `PORT` | Express 服务监听端口 | `3000` |
| `BLUEPRINT_SAVE_KEY` | **管理员保存密钥**，校验 `POST /api/blueprint/publish` | 留空则拒绝所有远程保存（返回 `403`） |
| `PROXY_UPSTREAM_BASE_URL` | 受信上游 API 根地址（仅命中时才注入 `PROXY_API_KEY`） | 留空 |
| `PROXY_ALLOWED_HOSTS` | 允许 `/api/proxy` 转发的域名白名单（逗号分隔） | `httpbin.org,api.github.com` |
| `PROXY_API_KEY` | 服务端私有密钥（绝不下发浏览器） | 留空 |
| `PROXY_API_KEY_HEADER` | 密钥注入请求头名称 | `Authorization` |
| `VITE_MOCK_SAVE_KEY` | 静态部署（GitHub Pages）Mock 模式演示密钥 | `atlas-demo-key` |

## 二、4 个核心 REST 接口契约

### 1. 读取权威底座：`GET /api/blueprint`
- 响应：`{ ok: true, serverRevision: number, blueprint: BaseBlueprint | null }`

### 2. 保存新权威底座：`POST /api/blueprint/publish`
- **鉴权请求头**：`X-Blueprint-Save-Key: <your-save-key>`
- 服务端使用 `crypto.timingSafeEqual` 恒定时间比对密钥；无密钥或密钥错误返回 `401`（服务端未配置返回 `403`）。
- 请求体：`{ blueprint: BaseBlueprint }`
- 响应：`{ ok: true, serverRevision: number }`

### 3. 代理状态探针：`GET /api/proxy/status`
- 响应：`{ enabled: true, hasUpstreamSecret: boolean, allowedHosts: string[] }`

### 4. 安全服务端代理：`POST /api/proxy`
- 请求体：`{ url: string, method?: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', headers?: Record<string,string>, body?: string }`
- **防 SSRF 与密钥隔离机制（`server/proxySecurity.ts` + `server/server.ts`）**：
  1. 强制校验协议仅限 `http:` / `https:`，禁止 URL 内嵌凭据；
  2. 强制匹配 `PROXY_UPSTREAM_BASE_URL` 或 `PROXY_ALLOWED_HOSTS` 白名单；
  3. 转发前执行 `dns.lookup(hostname, { all: true })`，拦截任何解析到内网、回环、链路本地或云元数据段（如 `127.0.0.0/8`、`10.0.0.0/8`、`169.254.169.254`、`::1`）的域名，防 DNS 重绑定绕过；
  4. `redirect: 'manual'` 强制拦截上游 3xx 重定向；
  5. 清洗 `Cookie`、`Host`、`Origin`、`Referer`、`Sec-*` 等敏感请求头；
  6. 强制 `10s` 超时与 `256 KB` 响应体截断，且仅对显式受信目标注入 `PROXY_API_KEY`。

> **静态部署安全边界**：在 GitHub Pages / 纯静态 HTML 预览模式下，`src/core/mockApi.ts` 会拦截 `/api/*` 并将蓝图底座存进浏览器 IndexedDB，方便演示交互；但纯静态环境不存在服务端可信边界，**切勿在前端环境变量或静态构建中放入真实私有 API Key**。

## 三、`room-go/` 多人实时协同房间说明

仓库内置了来自 `realtime-whiteboard` 的 `room-go/` 无头 Go 房间守护进程和 `src/core/crdt.ts`（确定性 `(rev, cid)` LWW 规则与版本化墓碑）：

```bash
cd room-go
go run . my-blueprint-room
```

若后续将前端接入 `room-go` 实现多人实时编辑，**请务必遵循两条安全/生产规范**：
1. **远端脚本信任门禁**：从协同房间同步来的 `entity.script` 或按钮 `code` 变更，不得自动静默执行，必须默认锁定并由本地用户人工审阅或校验管理员签名后放行；
2. **落盘与图片分离**：当前 `room-go/store.go` 为内存全量快照，生产上线前建议补充 SQLite/PostgreSQL WAL 持久化、按 Chunk 坐标范围查询，以及将插图上传至对象存储（S3/MinIO）只同步 URL。
