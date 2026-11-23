# v61 代码审查 — 01

> 审查日期：2026-11-24
> 审查范围：全仓库 `src/` 与 `server/` 全部 41 个源码文件（13623 行），非增量审查
> 结论：**需修改**。未发现崩溃级缺陷，但有 1 条默认配置即构成开放代理的安全默认值错误、1 条 DNS rebinding 窗口、以及若干数据丢失路径

## 改动范围核对

本次为全仓库审查，不针对某个版本的增量。基线为 `5bc5302`。

分区与文件数：

| 分区 | 文件数 | 代码行 |
| :--- | :--- | :--- |
| 主应用与状态协同 | 8 | 约 4400 |
| 画布渲染与控件 | 13 | 约 4100 |
| 脚本沙箱与面板 | 9 | 约 2900 |
| 服务端与 API 安全 | 9 | 约 2200 |

受保护文件（`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts`）本次仅读不改。

## 审查发现

### 已确认正确

以下为逐行核查过、确认无问题的关键点，记录下来避免后续重复审查。

**CRDT 与协同**

- `crdt.ts` 的 `beats()`：rev 大者胜、rev 相同比 cid 字典序，与 `roomServer.ts` 的 `RoomState` 三集合裁决规则一致。
- `roomServer.ts` 非 `/ws` 路径 upgrade：`listenerCount('upgrade') > 1` 才让位，否则 404 + `socket.destroy()`，不泄漏半开 socket。已实测可达。
- 房间销毁后同名重建：`handleMessage` 用闭包捕获的 `room` 实例 + `room.members.has(socket)` 双重校验，旧 socket 无法打入新房。
- `leave()` 幂等（`if (!member) return`），`error` 与 `close` 双触发不重复清理。
- 心跳：`alive` 标记 + 两轮未响应摘除，`pong` 重置。
- `rpcClient.ensureOpen()`：`connecting` promise 在 `fail` 时清理，`new WebSocket` 同步抛错路径不卡死 `connecting`；`onclose` 仅在 `wasActive` 时 reject 在途请求，旧连接不误杀新连接。

**Redis/存储**

- `idbStorage` 的 `db.onversionchange` 重连、`dbPromise` 断连重置逻辑正确。
- `layeredStore.applyOverlayToBase` 的 rev/cid 计算正确。
- `useOverlaySync` 首帧 `hydratedInitRef` 基线化防止回环广播，`cancelPendingLocalOverlaySave` 在跨页签消息到达时取消本地防抖，设计正确。

**React 受控渲染**

- `App.tsx` 的 `rfNodes` + `applyNodeChanges` 受控方案：`isDragging` 时保留 React Flow 自身 `position`，松手才写 overlay 并 `pushHistory` 一次——正确根治拖动频闪。
- `useEffect` 清理：`statusLog` 自动清除定时器、`roomClientRef` 卸载 disconnect、`ResizeObserver` 断开均有对应 cleanup。

**画布渲染**

- `ChunkTileCache.bake`：`pixelSize` 变化时 `canvas.width/height` 赋值隐式清空 context 状态，随后 `setTransform` 重置，无残影。
- `ChunkTileCache.get` 的四重失效条件（`dirty` / `version` / `lod` / `scale`）齐全。
- `ChunkUnderlayCanvas` DPR 处理：`min(dpr, 2)` + `setTransform(dpr)`，主画布高清烘焙后 `drawImage` 到世界坐标，插值正确。
- `ChunkUnderlayCanvas` 清理：`unsubscribe` / `removeEventListener('resize')` / `cancelIdlePrefetch` / `cancelAnimationFrame` 全部成对。

**API 轮询器**

- `ApiPollerBlock` 三重防护：`mountedRef` + `seqRef` + `AbortController`，`finally` 里 `mySeq === seqRef.current` 判定，卸载后不 setState。
- 每次请求只 `resp.text()` 一次，不存在 `Body stream already read`。
- `extractJsonPath` 正则严格校验 + `FORBIDDEN_PATH_SEGMENTS` 拒绝原型链段。

**脚本沙箱**

- `self` / `postMessage` 双重封锁：`defineProperty(self)` + 原型链置空。
- `widgets.create` 的 `dx: 0` / `x: ''` 坐标解析：`hasNum` 正确排除空串与 null。
- `widgets.remove` 同步清理 `edgeList`。
- `emitDownstream` 按 `dst.id` 去重。
- `checkDag` 孤儿边不入邻接表；`topoSort` 自环计入度不入邻接。
- `MAX_POOLED_WORKERS = 0`，每次执行独立 Worker + `terminate()`。
- `onmessage` / `onerror` 置 null 防迟到回调。
- `trigger.kind === 'validateConnect'` 时 `annotationOps` / `widgetOps` / `emitOps` 硬编码空数组丢弃副作用。

**服务端安全**

- `timingSafeEqual` 用法正确：先比长度再常量时间比较。
- 路径遍历：`makeRpcHandler` 用 `new URL(rawPath, 'http://127.0.0.1')` 归一化后校验 `/api/` 前缀，实测 `/%2e%2e/api/blueprint` → `/api/blueprint`（合法）、`/\t/api/blueprint` → 被拒、`//evil/api/blueprint` → 被拒。
- PDF 上传文件名净化：`replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)`，阻断 `../`、引号、`\r\n` 头注入。
- IPv6 判定：BigInt 解析覆盖 IPv4-mapped、NAT64、6to4、非规范压缩写法、方括号字面量，实测均被拦。
- `sanitizeProxyHeaders` 剥离 `Host` / `Cookie` / `Content-Length` / `Transfer-Encoding`。
- 重定向 `redirect: 'manual'` + apiCore 统一拦 3xx，不跟随到白名单外。
- `publishQueue` 串行化 `handleBlueprintPublish`，版本号不并发跳号。
- `Promise.race([fetcher.fetch, timeout])` 超时映射 504，不残留 pending。

**模板与工具**

- `taskList.toggleTaskLine` 保留 `\r\n` 的 `\r`，三条用例实测正确。
- `formatTaskTextForCanvas` 对空文本返回 `''`。
- `SearchJumpModal` 重开清空（`[open]` 依赖）。
- `NodeInspectorPanel` 切节点重置状态（`[node?.id]` 依赖）。
- `nudgeRight` 已用 `?? 960`，修复了 `x: 0` 瞬移。
- `nodeToCustomTemplate` 已携带 `script` 字段。
- `seedBlueprint` 4 个注释 + 9 个节点 id 自洽，`edge-flow-*` 引用的节点均存在。

### 非阻断问题

#### P1 `proxySecurity.ts:248` — 白名单未配置时成为开放代理

```ts
if (allowedHosts.length > 0 && !hostMatchesAllowlist(host, effectiveAllowlist)) { ... }
```

`allowedHosts` 为空时**跳过域名白名单检查**，`/api/proxy?url=<任意公网地址>` 直接放行。

- **触发条件**：自托管部署且未设置 `PROXY_ALLOWED_HOSTS` 与 `PROXY_UPSTREAM_BASE_URL`（`.env.example` 中这两项均为注释状态）。
- **影响面**：公网部署可见。服务器成为任意公网地址的出站中继，可用于绕过出口 IP 白名单、隐藏来源。
- **与浏览器端不一致**：`mockApi.ts` 的 `browserDeps.proxy.allowedHosts` 默认是 `['httpbin.org', 'api.github.com']`，**浏览器端默认收紧、服务端默认放开**，属于同一份 apiCore 在两种部署下的行为分叉。
- **缓解**：`isPrivateOrReservedIP` 的内网 IP 检查在**白名单之前**独立执行，所以内网/回环/元数据地址仍被拦（`proxySecurity.ts:239`）。因此这不是完整 SSRF，而是「任意公网代理」。
- **程度**：非阻断（需同时满足公网暴露 + 未配白名单）。但「配置即漏洞」的默认值应反过来：未配置时应默认拒绝并给出启动警告。
- **处理动作**：未改，记入已知遗留。

#### P2 `server.ts:295-334` — DNS 校验与 fetch 之间存在 rebinding 窗口

`dns.lookup(lookupHost, { all: true })` 校验全部解析结果后，把**主机名**交给 `fetch(target.url.toString())`。undici 建立连接时会**再次解析 DNS**，两次结果可以不同。

- **触发条件**：白名单中含攻击者可控域名，DNS 设 TTL=0，首次应答返回公网 IP 通过校验，连接时返回 `127.0.0.1`。
- **影响面**：公网部署可见。可打内网服务。
- **修复方向**：把校验过的 IP 固定到连接目标（undici 的 `connect.lookup` 回调返回已校验 IP），或直接连 IP + `Host` 头。仅做「先查后发」不能消除窗口。
- **程度**：非阻断（需攻击者控制白名单内的域名；且需叠加 P1 的宽松默认才有实际攻击面）。
- **处理动作**：未改，记入已知遗留。代码注释声称已缓解，与实现不符，这一点应在下次改动时修正注释或补实现。

#### P3 `ChunkUnderlayCanvas.tsx:420` — macro 视图连线箭头方向恒为 0

```ts
const angle = Math.atan2(ty2 - ty2, tx2 - (tx2 - dx));
```

`ty2 - ty2` 恒为 `0`，`tx2 - (tx2 - dx)` 恒为 `dx > 0`，因此 `angle` 恒为 `atan2(0, dx) = 0`。箭头两翼永远以 0 弧度对称张开，指向水平右侧，与贝塞尔曲线在终点处的实际切线方向无关。

- **触发条件**：macro 视图（zoom < 0.32）下任意连线。
- **影响面**：全量用户可见（全景下所有连线箭头方向都是错的）。
- **正确写法**：应取曲线终点切线方向，例如 `Math.atan2(ty2 - (ty2), tx2 - (tx2 - dx))` 改成用控制点 `tx2 - dx` 到终点 `tx2` 的方向 `atan2(0, dx)`——但更准确的是用 `(sy + ty2)` 的中点斜率或直接 `Math.atan2(ty2 - sy, tx2 - sx)`。
- **程度**：非阻断（纯视觉，不影响交互）。
- **处理动作**：未改，记入已知遗留。

#### P4 `App.tsx:1883` 等 — 撤销栈覆盖不全

以下路径修改 `base` 或 `overlay` 但**不调用 `pushHistory()`**：

| 路径 | 行号 | 用户操作 |
| :--- | :--- | :--- |
| `handleUpdateAnnotation` | 1883 | 编辑注释文字（每次输入） |
| `handlePatchNode` | 1534 | 改标题/正文/颜色/分类 |
| `handleToggleLock` | 1468 | 切换锁定 |
| `handleBatchUpdateRuntimeVars` | 1430 | 批量改运行变量 |
| `handleUpdateDefaultVar` | 1637 | 改默认变量 |
| `handleDeleteDefaultVar` | 1684 | 删默认变量 |

后果：改完注释点撤销，撤销的是**上一次**操作（例如拖拽节点），注释修改丢失。

- **触发条件**：上述任意操作后按 Ctrl+Z。
- **影响面**：全量用户可见。
- **程度**：非阻断（不丢数据，只是撤销粒度错位）。
- **处理动作**：未改，记入已知遗留。

#### P5 `widgetTemplates.ts:542` — 自定义模板无结构校验，脏数据导致抽屉白屏

```ts
export async function loadCustomTemplates(): Promise<BlueprintTemplate[]> {
  const saved = await idbGet<BlueprintTemplate[]>(CUSTOM_TEMPLATES_KEY);
  return Array.isArray(saved) ? saved : [];   // 只校验外层是数组
}
```

`TemplateDrawer.tsx:41` 的 `t.name.toLowerCase()` 在 `name` 缺失时抛 `TypeError`；`TemplateDrawer.tsx:204` 的 `np?.defaultVars[k]` 中 `?.` 只保护 `np`，`np` 存在但 `defaultVars` 缺失时仍抛错。

自定义模板持久化在 IndexedDB，**跨版本保留**。若旧版本写入的模板结构不完整，升级后打开抽屉即崩。

- **触发条件**：IndexedDB 中存在结构不完整的模板记录。
- **影响面**：特定用户可见（模板抽屉完全不可用）。
- **程度**：非阻断（仅影响历史脏数据，新装用户不受影响）。但这是唯一一条能导致 UI 局部完全不可用的缺陷。
- **处理动作**：未改，记入已知遗留。修复成本极低：在 `loadCustomTemplates` 里 `filter` 掉缺 `id`/`name`/`group`/`nodes` 的项。

#### P6 `useOverlaySync.ts:65` — 跨页签消息整块替换，吃掉本地未落盘状态

```ts
cancelPendingLocalOverlaySave();
lastSyncedFingerprintRef.current = fp;
setOverlay(remoteOverlay);   // 整块替换
```

若 A 页签刚由脚本更新 overlay（300ms 防抖未到），B 页签此时保存并广播，A 会取消自己的待写盘更新、用 B 的旧快照整块覆盖，且 `lastSyncedFingerprintRef` 被设为远端指纹，导致 A 的本地状态此后再也不会被写盘。

- **触发条件**：双开页签，且一个页签的脚本更新恰好在另一个页签保存广播的 300ms 窗口内。
- **影响面**：仅自托管 / 双开页签。
- **程度**：非阻断（窗口窄，需双开）。
- **处理动作**：未改，记入已知遗留。

#### P7 `idbStorage.ts:77` — 写盘失败静默，上层仍广播「已保存」

`idbSet` 在 `tx.onerror` / `onabort` 时 `resolve(false)`，但调用方 `layeredStore.saveLocalOverlay` 不检查返回值，继续向其他标签页 `postMessage` 广播更新。用户看到保存成功，刷新后丢失。

- **触发条件**：IndexedDB 配额满、隐私模式限额、事务被系统中断。
- **影响面**：特定环境。
- **程度**：非阻断（静默丢数据）。
- **处理动作**：未改，记入已知遗留。

#### P8 `server.ts:399` — `/api/pdf/:id/meta`、`/:id/page/:page`、`/:id` 三条路由无 token 校验

`app.use('/api/proxy', ...)` 只覆盖 `/api/proxy` 及其子路径。PDF 的五条路由中，`upload`（515）、`unpack`（561）、`unpack-upload`（633）单独调用了 `verifyProxyClientToken`，但 `meta`（659）、`page`（668）、`/:id` 下载（686）**没有校验**。

- **触发条件**：配置了 `PROXY_CLIENT_TOKEN` 后，任何人凭 docId 即可读取 PDF 元信息、页面图与原文件。
- **影响面**：公网部署可见。docId 由 `randomBytes(8)` 生成不可枚举，但会进入浏览器历史、Referer、以及被分享的蓝图 JSON（`url` 字段直接写在蓝图里）。
- **程度**：非阻断（需 docId 泄漏，但泄漏路径自然）。
- **处理动作**：未改，记入已知遗留。

#### P9 `server.ts:249` — 限流桶被五个路由共享，单请求消耗双份配额

`checkProxyRateLimit` 使用模块级单一计数器，被 `/api/proxy`、`/api/proxy/binary`、`/api/pdf/upload`、`/api/pdf/unpack`、`/api/pdf/unpack-upload` 共用。且 `/api/proxy` 经 Express 中间件拦一次、`apiCore.handleProxy` 内部再 `deps.rateLimit.check` 一次，**单个请求扣 2 个配额**。

- **影响面**：公网部署可见（限流实际生效值为宣称值的一半，PDF 与代理互相挤占）。
- **两端不一致**：浏览器直跑 apiCore 时每请求只扣 1 次，服务端扣 2 次。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P10 `apiCore.ts:307` — 256KB 上限按字符截断，中文场景实际可达 786KB

`MAX_RESPONSE_CHARS = 256 * 1024` 对 `text.slice()` 生效，按 UTF-16 码元计数。全 ASCII 时约 256KB，中文（3 字节/字符）时最多约 786KB。同时 `server.ts:332` 的 `readResponseBufferWithLimit(res, 2MB)` 按字节读，两个上限口径不同。

- **影响面**：公网部署可见（内存放大，RPC 帧体积超预期）。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P11 `roomServer.ts:83` 与 `server.ts:117` — 64MB 回包 base64 后 85MB，超出 72MB maxPayload

`MAX_RPC_RES_BYTES = 64MB` 的二进制经 base64 编码膨胀至约 85.3MB，超过 `MAX_RPC_WS_PAYLOAD_BYTES = 72MB`。超限时 `ws.send` 失败被 catch 吞掉返回 false，客户端只能等 60s 超时。

当前 PDF 上限 50MB（base64 后约 66.7MB）刚好能过，但余量不足 8MB。

- **影响面**：特定操作触发（接近上限的大 PDF）。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P12 `scriptAudit.ts:24` — `node.script` 非字符串时抛 TypeError，错误信息误导

```ts
if (node.script && node.script.trim()) { ... }
```

`script` 为 truthy 非字符串（数字/对象）时 `.trim` 不存在。`App.tsx:402` 的 `auditBlueprintScripts(normalized)` 在 `try` 内，异常会跳到 `catch` 显示「不是合法的 JSON」——错误信息完全误导，且导入被放弃。

- **触发条件**：导入含 `script: 123` 的节点。
- **影响面**：特定操作触发。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P13 `scriptSandbox.ts:340` — `widgets.create` 接受未审查的子脚本

`widgets.create({ script })` 创建的子控件脚本经 `App.tsx:1272` 直接 `runInIsolatedWorker`，**不再调用 `validateScriptSafety`**。

黑名单只对当前源码做词法匹配，运行期派生产物不受约束。虽然子脚本仍运行在 Worker 内、`self`/`postMessage` 已被封锁，但这一条破坏了「所有脚本都过预检」的一致性假设。

- **触发条件**：已信任的父脚本用拼接字符串构造子脚本。
- **影响面**：特定操作触发（需先有可执行的父脚本）。
- **程度**：非阻断（Worker 内危害有限）。
- **处理动作**：未改，记入已知遗留。建议在 `widgets.create` 返回前对 `spec.script` 补跑一次 `validateScriptSafety`。

#### P14 `chunkManager.ts:118` 与 `ChunkUnderlayCanvas.tsx:176` — 注释高度估算口径不一致

登记分块用 `Math.max(40, ann.height || ann.fontSize * 3)`，实际绘制用 `ann.height || Math.max(48, fontSize * 2.5)`。`height` 为空且 `fontSize` 较小时，登记高度（40）小于绘制高度（48），注释底部落在未登记的 chunk 里。

- **触发条件**：注释未设 height、字号小、位于 chunk 边界附近。
- **影响面**：macro 全景下跨块注释文字底部被裁。
- **程度**：非阻断（视觉瑕疵）。
- **处理动作**：未改，记入已知遗留。

#### P15 `ChunkUnderlayCanvas.tsx:132` — 任意图片加载完成触发 `tileCache.clear()`

远端插图 `onload` 后调用 `tileCache.clear()` 全量清空 160 块瓦片并逐帧重烘。

- **触发条件**：画布上有多张远程插图注释，其中一张首次进入视口时加载完成。
- **影响面**：全景下明显卡顿。
- **程度**：非阻断（性能）。
- **处理动作**：未改，记入已知遗留。

#### P16 `pdfClientUnpack.ts:93` — 全局 6 份 LRU 可能淘汰正在展示的文档

`while (clientDocStore.size >= MAX_CLIENT_DOCS)` 按插入序淘汰最早的一份。若该文档正被另一个 PDF 控件引用，被淘汰后 `renderClientPdfPageImage` 返回 `null`，控件永久停留在「正在渲染第 N 页…」，无错误提示、无恢复路径。

- **触发条件**：同一页面打开 ≥ 6 个本地解包的 PDF 控件后切回最早那个。
- **影响面**：特定操作触发。
- **程度**：非阻断（有边界但静默失效）。
- **处理动作**：未改，记入已知遗留。

#### P17 `ApiPollerBlock.tsx:314` — Enter 提交后 onBlur 二次提交

`onKeyDown` 的 `e.preventDefault()` 不阻止失焦。Enter 提交后焦点移开会再次 `commitUrl`，导致 `setBase` 与 `version++` 各多执行一次。

- **影响面**：特定操作触发（多一次全量瓦片重建，无数据错误）。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P18 `App.tsx:394` — 联机中导入蓝图会向房间广播大量 delete

`handleImportJSONFile` 执行 `setBase(normalized)` 后，增量 diff 用 `prevSyncedBaseRef`（旧 base）对比新 base，差异极大时向房间广播大量 `delete_node` / `delete_edge`。而 `delete_*` 消息不受 rev 保护（见下方 P19 说明）。

- **触发条件**：已连接房间时导入外部蓝图。
- **影响面**：全量房间用户可见（他人画布被清）。
- **程度**：非阻断（需主动操作）。
- **处理动作**：未改，记入已知遗留。

#### P19 `App.tsx:519` — `delete_node` 等删除消息不受 rev/cid 保护

`upsert_node` 走 `beats()` 裁决（rev 大者胜），但 `delete_node`（519）、`delete_ann`、`delete_edge` 无条件执行。任何房间成员发一条删除消息即生效，即使本地持有更高 rev 的版本。

- **触发条件**：房间内任一客户端发送删除消息（含重放、误发）。
- **影响面**：全量房间用户可见，且远端删除不进本地撤销栈。
- **程度**：非阻断（受信房间内可接受），但属 CRDT 完整性缺口。
- **处理动作**：未改，记入已知遗留。

#### P20 `App.tsx:497` — 协同脚本信任登记依赖 `scriptChanged` 判定

`upsert_node` 只在 `scriptChanged`（脚本或按钮内容变化）时把脚本加入 `untrustedScriptKeys`。若远端只改 `x/y` 而 `script` 与本地一致，该节点脚本不会被登记为待审阅。

- **影响面**：需构造特定消息序列，实际攻击面窄。
- **程度**：非阻断（理论风险）。
- **处理动作**：未改，记入已知遗留。

#### P21 `App.tsx:2296` — `handleSaveToBackend` 对同一 overlay 应用两次

先 `applyOverlayToBase(base, overlay)` 得到 `merged` 发给后端（2267），成功后对本地 base 再执行一次 `applyOverlayToBase(prev, publishedOverlaySnapshot)`（2296）。同一 patch 应用两次，rev 加两次。

- **影响面**：特定操作触发，rev 单调膨胀但不丢数据。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P22 `App.tsx:249` — `useMemo` 内部写 ref

```ts
const threeRingBounds = useMemo(() => {
  ...
  prevViewportCenterRef.current = { cx, cy };   // 副作用写在 useMemo 里
}, [viewportBucketKey]);
```

StrictMode 双调用时第二次读到第一次刚写入的值，`dirX/dirY` 计算为 0，三环方向预取失效。

- **影响面**：仅开发环境（StrictMode 双调用只在 dev）。
- **程度**：非阻断。
- **处理动作**：未改，记入已知遗留。

#### P23 `widgetTemplates.ts:553` 与 `NodeInspectorPanel.tsx:294` — `Date.now()` 生成 id

`id: \`custom-tpl-${Date.now()}\``、`id: \`in-${Date.now()}\``。同一毫秒内重复生成会产生 id 碰撞，`TemplateDrawer` 的 `key` 重复、按 id 删除会一次删两条。

- **触发条件**：同一毫秒内连点两次（人为操作几乎不可达，自动化可复现）。
- **影响面**：理论风险。
- **程度**：非阻断（置信度低）。
- **处理动作**：未改，记入已知遗留。建议加 `Math.random().toString(36).slice(2, 8)` 后缀。

### 审查过程中确认的误报

以下三点在初次分区审查中被报为问题，经逐行核实**不成立**，记录在此避免后续重复误判。

1. **「客户端不带 X-Proxy-Token，开启后 PDF/保存全 401」**——不成立。`apiClient.ts:15` 的 `proxyHeaders()` 会注入 `X-Proxy-Token`，且 `App.tsx:981`、`ApiPollerBlock.tsx:149/170`、`PdfViewerBlock.tsx:294/368` 五处调用点都已正确使用。真实问题是 P8（PDF 三条路由服务端不校验），方向相反。
2. **「`loadCustomTemplates` 导致白屏属阻断」**——降级为 P5 非阻断。新装用户不受影响，仅历史脏数据触发，且修复成本极低。
3. **「PDF/binary 未进 apiCore 违反唯一实现」**——这是设计取舍而非缺陷。`apiCore.ts:201` 的路由表刻意只覆盖 `/api/blueprint`、`/api/blueprint/publish`、`/api/proxy/status`、`/api/proxy` 四条；PDF 全链路依赖 `multer`/`pdfjs`/文件存储，浏览器端无法同构执行，放进去反而要造两套实现。注释（`server.ts:393`）已说明「部署层鉴权刻意不进 apiCore」。记录为**已知设计边界**，不算缺陷。

## 已知遗留 / 未生效项

| # | 位置 | 问题 | 触发面 |
| :--- | :--- | :--- | :--- |
| P1 | `proxySecurity.ts:248` | 白名单为空即开放代理，与浏览器端默认相反 | 公网部署 + 未配白名单 |
| P2 | `server.ts:295` | DNS 校验与 fetch 二次解析之间的 rebinding 窗口 | 公网部署 + 攻击者控白名单域名 |
| P3 | `ChunkUnderlayCanvas.tsx:420` | macro 连线箭头角度恒为 0 | 全量用户可见 |
| P4 | `App.tsx:1883` 等 6 处 | 注释/标题/锁定/默认变量修改不入撤销栈 | 全量用户可见 |
| P5 | `widgetTemplates.ts:542` | 自定义模板无结构校验，脏数据致抽屉崩溃 | 历史脏数据 |
| P6 | `useOverlaySync.ts:65` | 跨页签整块替换吃掉本地未落盘状态 | 双开页签 |
| P7 | `idbStorage.ts:77` | 写盘失败静默，上层仍广播已保存 | 配额满 / 隐私模式 |
| P8 | `server.ts:659/668/686` | PDF meta/page/下载三条路由无 token 校验 | 公网部署 + docId 泄漏 |
| P9 | `server.ts:249` | 限流桶五路由共享，单请求扣双份配额 | 公网部署 |
| P10 | `apiCore.ts:307` | 256KB 上限按字符算，中文场景实际 786KB | 公网部署 |
| P11 | `roomServer.ts:83` | 64MB 回包 base64 后 85MB 超 72MB maxPayload | 接近上限的大 PDF |
| P12 | `scriptAudit.ts:24` | `node.script` 非字符串抛 TypeError，错误信息误导 | 导入脏数据 |
| P13 | `scriptSandbox.ts:340` | `widgets.create` 子脚本不过预检 | 特定脚本 |
| P14 | `chunkManager.ts:118` | 注释高度估算与绘制口径不一致 | chunk 边界注释 |
| P15 | `ChunkUnderlayCanvas.tsx:132` | 任意图片加载完成触发全量瓦片清空 | 多远程插图 |
| P16 | `pdfClientUnpack.ts:93` | 6 份 LRU 可能淘汰在展示的文档 | ≥7 个 PDF 控件 |
| P17 | `ApiPollerBlock.tsx:314` | Enter 后 onBlur 二次提交 | 特定操作 |
| P18 | `App.tsx:394` | 联机中导入触发大量 delete 广播 | 联机 + 导入 |
| P19 | `App.tsx:519` | 删除消息不受 rev 保护 | 房间内任一成员 |
| P20 | `App.tsx:497` | 信任登记依赖 scriptChanged 判定 | 理论风险 |
| P21 | `App.tsx:2296` | 保存到后端对同一 overlay 应用两次 | 连续保存 |
| P22 | `App.tsx:249` | useMemo 内写 ref | 仅 dev |
| P23 | `widgetTemplates.ts:553` | Date.now() 生成 id 碰撞 | 理论风险 |

**全部 23 条均未修改**，本次为纯审查，不含修复。

## 验证记录

本次审查为静态阅读，未执行本地构建（遵循 `AGENTS.md` 的「不要在本机执行 `npm install` / `npm run build` / `tsc`」）。

- 审查基线：`5bc5302`
- 源码规模：`src/` + `server/` 共 41 个 `.ts`/`.tsx` 文件，13623 行
- 分区方式：4 个不重叠分区并行逐行阅读，交叉核对 `App.tsx` 调用方
- 关键问题均经二次人工核实行号与代码原文，未依赖单次推断
- 3 条初次报告的问题经复核判定为误报，已在「审查过程中确认的误报」中记录

结论：**需修改**。P3（箭头方向）与 P4（撤销栈覆盖）是用户可直接感知的缺陷，修复成本低，建议优先处理；P1、P2、P8 是安全默认值与边界问题，公网部署前必须处理。其余为长期遗留，不阻塞当前静态托管发布。
