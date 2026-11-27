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

> **静态部署安全边界**：在 GitHub Pages / 纯静态 HTML 预览模式下，`src/core/mockApi.ts` 会拦截 `/api/*` 并在浏览器内执行 `src/core/apiCore.ts`，蓝图底座存进浏览器 IndexedDB，方便演示交互；但纯静态环境不存在服务端可信边界（浏览器拿不到对端 IP，也无从部署限流与鉴权），**切勿在前端环境变量或静态构建中放入真实私有 API Key**。
>
> **接口逻辑只有一份**：`/api/*` 的业务实现在 `src/core/apiCore.ts`，服务端 Express 路由与浏览器拦截器都调用它，各自只提供传输与存储适配。配置 `VITE_BACKEND_WS_URL` 后，前端的 `/api/*` 会经 WebSocket 转发到服务端执行同一份逻辑；未配置则在浏览器内执行。两种模式的返回结构一致，除如实标注的 `mode` 标记外无差异。

## 三、WebSocket 协同房间说明（`server/roomServer.ts`）

协同房间由 Node 服务端内建，与 Express **共用同一个 HTTP server 与端口**，通过 `upgrade` 事件按 `/ws` 分流。不再需要单独的 Go 进程。

### 启动

```bash
npm run dev          # 同时启动 API 与协同房间，默认端口 8787
```

启动后：
- HTTP API：`http://localhost:8787`
- 协同房间：`ws://localhost:8787/ws?room=<房间名>&cid=<客户端ID>`
- 房间统计：`GET http://localhost:8787/api/room/stats`

前端 `App.tsx` 的默认房间地址就是 `ws://localhost:8787/ws`，开箱即用。

### 协议

与 `src/core/roomClient.ts` 的 `RoomWireMessage` 逐字对齐：

| 方向 | 消息 |
| --- | --- |
| C→S | `{t:'hello', room, cid}`（连接 URL 已带参数，服务端忽略此帧） |
| C→S | `{t:'state', blueprint}` 覆盖整份房间状态 |
| C↔S | `{t:'upsert_node', node}` / `{t:'delete_node', id}` |
| C↔S | `{t:'upsert_ann', annotation}` / `{t:'delete_ann', id}` |
| C↔S | `{t:'upsert_edge', edge}` / `{t:'delete_edge', id}` |
| S→C | `{t:'state', blueprint}`（新成员入房时补发全量快照） |
| S→C | `{t:'peer_joined', cid}` / `{t:'peer_left', cid}` |
| S→C | `{t:'error', error}` |

### CRDT 裁决

与 `src/core/crdt.ts` 的 `beats()` 逐行等价：`rev` 大的赢，`rev` 相同则 `cid` 字典序大的赢。前端 `crdt.ts` 与服务端 `roomServer.ts` 两处实现规则一致，可互操作。

### 容量上限

| 项 | 上限 | 超限行为 |
| --- | --- | --- |
| 房间数 | 64 | 新建房被拒 |
| 单房间成员 | 32 | 入房被拒，返回 `error` 帧后关闭 |
| 单帧大小 | 4MB | `ws` 库直接断开 |
| 每集合记录数 | 5000 | 拒绝写入（已存在的仍可更新） |
| 单字符串字段 | 512KB | 消息被判非法 |
| 心跳 | 30s | 未回 pong 的连接被 terminate |

### 安全说明

1. **远端脚本信任门禁**：从协同房间同步来的 `entity.script` 或按钮 `code` 变更，不得自动静默执行，必须默认锁定并由本地用户人工审阅或校验管理员签名后放行（`App.tsx` 中 `msg.t === 'state'` 分支已接入 `auditBlueprintScripts`）。
2. **当前无鉴权**：房间名即凭据，知道房间名即可加入。**不要用于公网开放场景**，或在外层加反向代理鉴权。
3. **纯内存**：房间状态不落盘，进程重启即丢失。生产环境建议补 SQLite/PostgreSQL WAL 持久化，并将插图上传至对象存储（S3/MinIO）只同步 URL。


## 同源相对 WebSocket 路径（v102）

`VITE_BACKEND_WS_URL` 支持相对路径 `/ws` 以及关键词 `auto` / `same-origin`：浏览器运行时会根据 `window.location.protocol`（`https:` → `wss:`，其余 `ws:`）与 `window.location.host` 自动拼接 WebSocket 地址，避免在 Docker / HTTPS 反代 / Cloud Shell 场景下因域名变更重新构建前端镜像。协议相对地址（`//...`）会被显式拒绝。
