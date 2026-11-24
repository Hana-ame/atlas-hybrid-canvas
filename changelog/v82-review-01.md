# v82 代码审查 — 01

> 审查日期：2026-11-24
> 审查基线：`1490ab0`（v78~v82 合并后）
> 审查范围：`server/`（6 文件 2850 行）、`src/core/` 协同与存储链路、`src/hooks/` 两个 Hook、`src/App.tsx` 房间与回档逻辑
> 结论：**需修改**。有 2 条可直接利用的鉴权缺陷（其中 1 条为 v79 引入的回归）、1 条限流绕过、1 条静态模式功能缺失。无崩溃级缺陷。

## 审查方式

逐行阅读，不依赖测试通过作为正确性证据。所有结论均给出文件名与行号，可复核。

GitHub Actions 侧已跑通 `typecheck + 131 测试（含真实进程 E2E）+ 双构建`，但这只证明「代码自洽」，不证明「安全边界正确」——下列 P0/P1 均不触发任何测试失败。

---

## P0 · 鉴权缺陷

### P0-1　`POST /api/auth/session` 在 Origin 缺失时无凭证签发令牌

**位置**：`server/server.ts:335`

```ts
const origin = String(req.header('origin') || '').trim();
const isSameOrigin = Boolean(origin && host && (...));
const isAllowedCorsOrigin = Boolean(origin && corsAllowedOrigins.has(origin));
if (origin && !isSameOrigin && !isAllowedCorsOrigin) {   // ← origin 为空即整条短路
  res.status(403)...
  return;
}
```

`origin` 为 `''` 时 `if ('')` 为假，直接进入签发分支。

**复现**（配置了 `AUTH_SESSION_SECRET` 的生产部署）：

```
curl -X POST https://<host>/api/auth/session \
     -H 'content-type: application/json' -d '{"cid":"x"}'
→ {"ok":true,"token":"<184 字符 base64url>","expiresInSec":3600,"mode":"signed"}
```

**可获得权限**（令牌经 `verifyProxyClientToken` 与 HTTP / WS 共用）：

| 能力 | 路由 |
| :--- | :--- |
| 读任意房间蓝图 | `GET /api/rooms/*/blueprint` |
| 读任意房间版本历史 | `GET /api/rooms/*/history` |
| 加入任意房间并协同编辑 | `WS /ws/<roomPath>` |
| 调用出站代理（若配 `PROXY_API_KEY` 则借用服务端上游密钥） | `/api/proxy`、`/api/proxy/binary` |

发布与回档不受影响，仍由 `X-Blueprint-Save-Key` 保护（`apiCore.ts:148`、`server.ts:710-715`）。

**回归性质**：v75/v76 曾用「必须校验静态引导凭证 `PROXY_CLIENT_TOKEN`」堵住同类问题；v79 删除该机制后改为 Origin 判断，未保留「Origin 必须存在」的前置条件。

**修复方向**：签发前要求 `origin` 非空；并对无 Origin 的服务端调用改用独立的管理密钥通道，而非复用浏览器会话。

### P0-2　Origin 本身是客户端可控头，CORS 白名单不构成认证边界

**位置**：`server/server.ts:236-241`（白名单读取）、`:335`（判定）

即使补上「Origin 必须存在」，脚本仍可：

```
curl -X POST ... -H 'Origin: https://allowed.example.com'
```

`CORS_ALLOWED_ORIGINS` 只能约束浏览器同源策略，无法约束非浏览器客户端。v79 changelog 中「防自动化会话令牌」的设计目标，无法仅靠 Origin 达成。

**结论**：`/api/auth/session` 当前的防护实质只有 `PROXY_RATE_LIMIT_PER_MIN`（默认 30/分/IP），且该限流键可被绕过（见 P1-1）。

---

## P1 · 高危

### P1-1　`X-Forwarded-For` 未经验证即作为限流键，限流可绕过

**位置**：`server/roomServer.ts:511` → `server/server.ts:117`、`:262-267`

```ts
// roomServer.ts:511
const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
const clientIp = fwd || req.socket.remoteAddress || 'unknown';
```

```ts
// server.ts:117 —— 客户端提供的值原样塞进内部头
if (frame.clientIp) headers['x-atlas-rpc-ip'] = frame.clientIp;

// server.ts:262-267 —— 只要来自回环且内部密钥匹配，就采信该值
if (isLoopback && req.header('x-atlas-rpc-secret') === INTERNAL_RPC_SECRET) {
  const rpcIp = String(req.header('x-atlas-rpc-ip') || '').trim();
  if (rpcIp) return rpcIp;
}
```

信任链在起点就断了：`frame.clientIp` 完全来自客户端在 WS 握手时自填的 `X-Forwarded-For`，服务端未做任何「该连接是否来自可信代理」的判定。

**后果**：
- 每次请求换一个伪造 IP，即绕过 `PROXY_RATE_LIMIT_PER_MIN`（`/api/proxy`、`/api/auth/session`、`/api/proxy/binary` 共用同一个 `checkProxyRateLimit`）；
- 反向利用可污染他人限流桶（对指定 IP 造成 429）。

**修复方向**：仅在显式配置 `TRUST_PROXY=true` 时才读取 `X-Forwarded-For`，否则一律用 `req.socket.remoteAddress`；或引入可信代理 CIDR 白名单。

### P1-2　`/api/proxy` 与会话令牌共用鉴权，匿名令牌可间接使用服务端上游密钥

**位置**：`server/server.ts:619-630`、`:294-298`

`app.use('/api/proxy', ...)` 只调 `verifyProxyClientToken`，而该函数在拿到任意有效会话令牌时返回 true。结合 P0-1/P0-2，任何脚本都能取得令牌并驱动注入了 `PROXY_API_KEY` 的出站代理。

`PROXY_API_KEY` 的设计前提是「密钥仅留服务端，绝不下发前端」，但它被一个匿名可达的令牌体系间接开放。

**修复方向**：`/api/proxy` 改用独立管理密钥（例如复用 `BLUEPRINT_SAVE_KEY` 之外的 `PROXY_ACCESS_KEY`），与会话令牌解耦。

---

## P1 · 功能缺失（静态模式）

### P1-3　`getRoomStore` 仍未注入浏览器侧，纯静态模式所有房间共用一份蓝图

**位置**：`src/core/apiCore.ts:381`（使用）、`src/core/mockApi.ts:118-129`（`browserDeps` 未提供）

```ts
// apiCore.ts:381
const roomStore = deps.getRoomStore ? deps.getRoomStore(rawRoom) : deps.store;
```

```ts
// mockApi.ts:118-129 —— 无 getRoomStore 字段
const browserDeps: ApiDeps = {
  store: browserStore,
  proxy: {...},
  rateLimiter: ...,
  fetcher: browserFetcher,
  mode: 'browser',
};
```

全仓 `getRoomStore` 出现位置：`apiCore.ts` 2 处（声明 + 使用）、`roomServer.ts` 4 处（服务端注入并正确使用）、`mockApi.ts` **0 处**。

**后果**：GitHub Pages 线上（纯静态）访问 `/api/rooms/<任意路径>/blueprint` 均回落到同一个 `browserStore`（固定 key `atlas-hybrid-mock-server-blueprint-v1`），换房间读到同一张图，发布写同一条记录。v74 引入的「按 path 分房间」在静态模式下不生效。

服务端模式不受影响：RPC 走本机回环打到 Express 的 `/api/rooms/*/blueprint`，那里用 `resolveRoomApiDeps` 正确取到独立 store。

---

## P2 · 设计隐患

### P2-1　WebRTC P2P 帧绕过服务端，不落盘、不审计、无服务端 LWW 兜底

**位置**：`src/core/webrtcMesh.ts:72-76`、`src/core/roomClient.ts:255-271`

`send()` 同时走 P2P 与 WS（`broadcastRaw` 后仍 `ws.send`），因此不存在「第三方成员收不到」的分叉问题，接收侧也有 2 秒/256 条去重（`roomClient.ts:226-239`）。这一点是正确的。

但 P2P 帧由 `onDataMessage` 直接交给 CRDT 合并管线，**服务端不可见**：
- `roomServer.schedulePersistRoom` 只对 WS 收到的帧触发，P2P 独有帧不落盘；
- 服务端 `RoomState` 不参与该帧的 LWW 裁决，无法作为权威兜底；
- 脚本变更的信任审计（`auditBlueprintScripts`）在客户端侧执行，绕过服务端不可审计。

由于双发设计，实际落盘依赖 WS 副本；但若 WS 侧因去重被跳过（P2P 先到、WS 后被 `isDuplicateFrame` 丢弃），**服务端仍收得到该帧**（去重只在接收端），故落盘不受影响。真正缺失的是「服务端权威校验」而非持久化。

**建议**：明确 P2P 仅作为低延迟加速层，服务端始终为权威；在文档中写清「不要依赖 P2P 做安全边界」。

### P2-2　`fileStore.ts` 保留约 100 行生产死代码，且由测试维持存活

**位置**：`server/fileStore.ts:40-46`（`sanitizeRoomFileKey`）、`:52-105`（`createFileBlueprintStore`）、`:110-139`（`loadRoomSnapshotFile` / `saveRoomSnapshotFile`）

全仓引用统计（排除 `fileStore.ts` 自身）：

| 导出 | 生产引用 | 测试引用 |
| :--- | :--- | :--- |
| `createFileBlueprintStore` | 0 | `tests/fileStore.test.ts:14,17,25,37` |
| `saveRoomSnapshotFile` | 0 | `tests/fileStore.test.ts:52` |
| `loadRoomSnapshotFile` | 0 | `tests/fileStore.test.ts:53` |
| `sanitizeRoomFileKey` | 0 | `tests/fileStore.test.ts:46,47` |

v79/v80 已把存储统一到 `rooms/<key>.json` 单一事实源，`server.ts:48-49` 只实例化 `createRoomBlueprintStoreRegistry`。上述四个导出已无生产调用，却被三个测试断言为「通过」。

风险不是崩溃，而是**误导**：`sanitizeRoomFileKey` 看似是路径遍历防护，实际生效的是 `roomPathToFileKey`（`fileStore.ts:147`）。后来者若照 `sanitizeRoomFileKey` 的实现改 `roomPathToFileKey`，会破坏现有的防碰撞摘要。

**建议**：删除四个死导出与其测试；或明确标注 `@deprecated 仅供历史数据迁移`。

### P2-3　注释与实现脱节

**位置**：`server/server.ts:614-618`

```ts
/**
 * 部署层鉴权：配置了 PROXY_CLIENT_TOKEN 就必须带对 X-Proxy-Token。
 ...
 */
```

v79 已删除 `PROXY_CLIENT_TOKEN`，`verifyProxyClientToken`（`:294`）只校验 `AUTH_SESSION_SECRET` 签发的令牌。该注释会让运维以为还存在静态令牌开关。

同类：`src/vite-env.d.ts:10-11` 仍声明 `VITE_PROXY_CLIENT_TOKEN?: string`，实际已无任何读取点（`.env.example` 也已清空该项）。

**位置补充**：`server/server.ts:620` 的 `const isBinaryRoute = req.path === '/binary';` 声明后从未使用。

### P2-4　`listPersistedRooms` 返回文件键而非房间路径

**位置**：`server/fileStore.ts:426-439`

从磁盘文件名反推 key，对含特殊字符的房间会返回 `team__design__<hash8>` 而非 `team/design`，`GET /api/rooms` 的 `persisted` 字段对人类不可读，也无法直接用于回填 `?room=`。

**建议**：在 `<key>.json` 内冗余存 `roomPath`，或维护反向映射文件。

---

## P3 · 低危与观察项

| 编号 | 位置 | 描述 |
| :--- | :--- | :--- |
| P3-1 | `fileStore.ts:335` | 历史条目上限 50（`:186`），被 `slice(-50)` 截断后，回档到更早版本返回「未找到版本 vN」。UI 未提示该限制。 |
| P3-2 | `useRoomCollaboration.ts:119-128` | `replace: true` 帧整体替换 `base`，本地未同步的离线队列编辑被直接丢弃。属「权威发布优先」的设计取舍，但无任何提示。 |
| P3-3 | `roomClient.ts:231-237` | `recentFrames` 清理条件 `now - ts >= 2000 \|\| this.recentFrames.size > 256` 在迭代中改变 `size`，语义含混；行为上等价于「删到剩 256 为止」，可读性差。 |
| P3-4 | `server.ts:619` + `:763-794` | `/api/proxy` 被 `app.use` 前缀中间件与 `app.all` 循环各挂一次鉴权，`/api/proxy/binary` 内又单独校验（`:809`），三重冗余。无害但增加改动时漏改的风险。 |
| P3-5 | `App.tsx:172-191` | `loadRoomHistory` 无 `active` 竞态保护，快速开关保存弹窗时旧响应可能覆盖新列表。 |
| P3-6 | `App.tsx:519-534` | 切房间时 `flushLocalOverlaySave()` 未配对 `cancelPendingLocalOverlaySave()`；旧防抖若已排队会重复写一次（幂等，无害）。 |
| P3-7 | `layeredStore.ts:157` | 跨页签过滤 `if (data.storageKey && data.storageKey !== expectedKey) return;` —— 旧版页签广播若不带 `storageKey` 会跳过过滤，理论上跨房间误应用。 |

---

## 已确认正确的部分

记录在此，避免后续重复审查。

**鉴权与令牌**

- `authSession.ts` 先验签（`timingSafeEqual` 且先比长度）再解析 payload，顺序正确，不信任未认证数据。
- `parseCookieValue` 逐段解析、`decodeURIComponent` 失败回退原值，无抛错路径。
- WS 握手鉴权在 `upgrade` 阶段完成，失败先写 401 再 `socket.destroy()`，不进入 WS 协议栈。
- 子协议令牌：`handleProtocols` 只回显 `atlas-v1`（`roomServer.ts:200`），不把 `atlas-auth.<token>` 回显给客户端。
- `verifySaveKey`（`server.ts:710`）长度比较 + `timingSafeEqual`，正确。

**存储与并发**

- `roomPathToFileKey`：纯 `[A-Za-z0-9_-]` 保持原名，其余追加 8 位 SHA-256 摘要，杜绝 `team/design` 与 `team_design` 碰撞（`fileStore.ts:147-158`）。
- `atomicWriteJson`：`mkdir -p` + 唯一临时名 + `fs.rename`，原子替换。
- `RoomBlueprintStore` 的 `writeChain` 串行化覆盖主文件与 history 文件（`fileStore.ts:230-248`），REST 与 WS 共用同一实例（`server.ts:1100` 注入 `getRoomStore`）。
- `recordHistory` 对 `collab` 做序列化去重（`fileStore.ts:287-293`），避免无实质变更撑爆 50 条上限。
- `rollbackToVersion` 深拷贝目标快照后再替换，避免历史条目被后续修改污染。

**CRDT 与协同**

- `mergeRecordFieldsLWW` 的 `incExists && !curExists` 分支为 `!curKeyStamp || beats(incStamp, curKeyStamp)`，既保留了低 `cid` 同 `rev` 的新增字段，又让 `curRevs[key]` 的墓碑继续拦截陈旧重加（`crdt.ts`）。
- 服务端 `RoomState.upsert` 直接 import 浏览器侧同一函数（`roomServer.ts:19`），两端裁决 100% 同源。
- `recordSyncedMeta` 三处均登记远端原始记录，不再用合并后的抬高 `rev` 污染同步水位。
- `computeRecordDiff` 为变更字段逐项打 `{rev, cid}` 戳，自环/重复键由 `META_FIELDS` 排除。
- `join()` 改为 `if (!states.has(roomName)) states.set(...)`，保留 REST 预水合状态（`roomServer.ts:289`）。
- `rtc_*` 信令分支从 `room.members.get(socket)?.cid` 读取发送方，不再引用作用域外的 `cid`（`roomServer.ts:451`）。

**前端**

- `roomPath.ts` 的 `extractRoomPathFromBrowserLocation` 正确剥离 `import.meta.env.BASE_URL`，子路径部署不再把仓库名当房间名（`roomPath.ts`）。
- `roomClient` 稳定窗口 5s 才归零重连计数，且 `onclose` 清理 `stabilityTimer`，无热循环。
- P2P 与 WS 双发 + 接收侧去重，帧不会重复应用（CRDT 本身幂等，重复也无害）。
- `useBlueprintHistory` 全部 IDB 操作走 `enqueueIdb` 串行队列，冷栈撤销有序。
- `idbStorage.idbCacheSet` 按 `:` 前缀分命名空间独立 LRU，PDF 页与撤销快照不再互相淘汰。
- `CanvasErrorBoundary` 双层包裹，节点级错误不扩散为整画布白屏。

**CI**

- `deploy-pages.yml` 与 `ci.yml` 均在 `npm test` 之前执行 `npm run build:server`——`tests/serverIntegration.test.ts` 直接 `spawn node dist-server/server.mjs`，次序反了必然超时。
- 两个工作流都安装 `poppler-utils`——`tests/pdfUnpack.test.ts` 真实渲染 PDF，缺 `pdftoppm`/`mutool` 会 `spawn ENOENT`。

---

## 建议处理顺序

1. **P0-1 + P1-1**：一条 curl 即可利用，且限流形同虚设，优先修。
2. **P1-2**：把 `/api/proxy` 的鉴权与会话令牌解耦，避免上游密钥被间接开放。
3. **P1-3**：静态模式分房，影响线上 GitHub Pages 的实际功能。
4. **P2-2 + P2-3**：清理死代码与误导性注释，纯收益、零风险。
5. 其余按版本节奏处理。

修复后建议补两类测试，把这次的盲区堵上：
- **无 Origin 的 `/api/auth/session` 必须 401/403**（当前 E2E 只覆盖「非法 Origin 403」与「同源 Origin 放行」）；
- **伪造 `X-Forwarded-For` 不改变限流桶**（连发 N+1 次应仍触发 429）。
