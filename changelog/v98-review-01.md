# v98 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：`atlas-hybrid-canvas-v98-fixed.zip`（基于 `2ebc8e1`）相对 v97 的全部 18 个文件改动，及与本地独立测试的合并结果
> 结论：**可发布**（无阻断；3 项非阻断，均为部署前提/测试口径/已知词法层限制）

审查方式：逐行核对服务端与核心模块改动，独立编写 4 条安全/并发用例并按新几何改写独立⑦；不采信交付包自带结论，本地不跑构建与测试。

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 服务端 | `server/roomServer.ts`、`fileStore.ts`、`server.ts` | clientIp 覆写、水合 in-flight、6 条房间路由解码、异步错误兜底齐全 |
| 核心 | `scriptSandbox.ts`、`crdt.ts`、`agentOps.ts`、`seedBlueprint.ts` | 沙箱 token、字段戳对齐、Agent 双路径校验、ZONE F 新几何 |
| 协同 | `useRoomCollaboration.ts`、`useOverlaySync.ts`、`App.tsx` | 移除事后 bumpRev、切房刷盘、图片 URL 白名单 |
| 部署 | `Dockerfile` | Node 22、构建 MCP、安装 poppler-utils |
| 测试/文档 | 6 个既有测试 + `v98.md` + 全仓审查 | README 仅推进版本号，保留本地连线交互文档 |

## 审查发现

### 已确认正确

1. **WS RPC 客户端 IP 覆写到位**：文本帧用 `{ ...rawFrame, clientIp }` 生成新对象再交给 handler，二进制帧同样注入 `clientIp`，客户端 JSON 内自报字段被整体覆盖。`clientIp` 取自握手期 `req.socket.remoteAddress`，仅在 `TRUST_PROXY=1` 时读 `X-Forwarded-For` 首段。
2. **水合竞态已消除**：`hydrationPromises` 与 `hydratedRooms` 分离，`hydratedRooms` 在水合完成后才置位，`flushRoomSnapshot()` 发现 in-flight 先 `await`；`fileStore` 的 `ensureLoaded` / `ensureHistoryLoaded` 复用同一 Promise，失败后 `loaded` 仍为 false 可重试，不会再把空快照写回磁盘。
3. **房间路由解码一致**：`/blueprint`、`/blueprint/publish`、`/history`、`/agent/state`、`/ops`、`/rollback` 六条 `(.+)` 路由统一走 `safeDecodeRoomParam()`，畸形编码返回 400。
4. **`import` 拦截不会误伤内置脚本**：`validateScriptSafety()` 用 `\bimport\b` 词边界匹配，`important` / `importance` 不触发；已核对 `seedBlueprint.ts` 与 `widgetTemplates.ts` 的脚本字符串中没有独立的 `import` 词。
5. **CRDT 字段戳与顶层 rev 同步**：`computeRecordDiff()` 的 `externalMin` 参与 `max(prev.rev, next.rev, externalMin) + 1`，变更字段的 `fieldRevs[k]` 使用同一个 `nextRev`；`useRoomCollaboration` 改为先传 `getMinRev` 再 `trackSent` 记录实际发出的 rev，不再事后抬高顶层而漏掉字段戳。
6. **Agent 校验覆盖双路径**：`create_widget` 与 `update_widget` 均对合并后的 `contents` 做 `validateBlocksSafety()`，对 `buttons[].code` 仅在 `actionType === 'script'` 时做 `validateScriptSafety()`；原本只校验 `item.blocks` 的绕过口被补上。
7. **停机与发布串行**：`close()` 在 `wss.close` 回调里 `Promise.allSettled(flushTasks).finally(resolve)`，不再提前 resolve；`syncPublishedBlueprint()` 先清 `persistTimers` 再写状态，`/blueprint/publish` 纳入 `runSerializedForRoom`。
8. **P3 收口**：PDF 路由不再回显 `err.message`；Express 4 异步路由统一 `asyncHandler` 转发错误中间件；切房前 `flushLocalOverlaySave()`；两处 `annotationOps` 应用前用 `isSafeImageUrl()` 过滤 `imageUrl`。
9. **独立测试合并正确**：`tests/edgePathIndependent.test.ts` 的独立⑦已按 v98 新几何改写——障碍从 4 张卡扩到 5 张（`fsm-monitor`）、控制点总数 14→17、cancel 走廊改为夹在横幅下沿 1989 与卡片上沿 2060 之间；pause/resume 的断言从「x 不相交」改为「无完全重合坐标 + 纵向间距 ≥30px」，与 v98 的实际设计（共用 `x=1075` 转向点、y 相差 42px）一致，而不是简单放宽。

### 非阻断问题

1. **`TRUST_PROXY=1` 下的 IP 信任边界需运维保证**（`server/roomServer.ts:517-521`）：开启后直接采信 `X-Forwarded-For` 首段，若服务端口对公网裸奔而客户端自带该请求头，IP 仍可伪造。影响面：仅自托管且误配代理的部署。处理动作：**未改，需部署文档约束"仅在可信反向代理后开启"**：默认关闭时取 socket 地址，是安全的。
2. **动态 `import()` 仍是词法层拦截**（`src/core/scriptSandbox.ts`）：`\bimport\b` 只挡住字面量关键字，组合式构造仍可能绕过。影响面：用户主动信任外部恶意脚本时。处理动作：**未改，v98.md 已记入已知遗留**，后续需 CSP / sandboxed iframe 在浏览器层兜底。
3. **`validateButtonsSafety` 只校验 `actionType === 'script'`**：其它 actionType 携带的 `code` 字段不会进入脚本校验。影响面：仅当模板/外部数据给非 script 按钮塞入可执行代码时；当前前端不执行这类 code。处理动作：**未改，非阻断**，与现有按钮执行语义一致。

### 阻断问题

无。

## 验证记录

- 新增 `tests/v98SecurityIndependent.test.ts` 4 条：动态 import 词边界反证、`update_widget` 双路径拦截、CRDT rev 抬高与不反向降低、fileStore 并发冷启动后写入不被回退。
- 独立⑦按新几何手算核对：17 个控制点全部落在 5 张卡与横幅 `y=1945..1989` 之外；pause y=2290 与 resume y=2332 的纵向间距 42px ≥ 30px。
- `tests/` 合计：上游声明 193 条 `test()`，本地另加 4 条独立用例；`npm run typecheck` 不含 `tests/`，测试正确性由 `npm test` 运行时断言覆盖。
- CI / Pages：本地不执行，推送后以 GitHub Actions run、部署产物 hash 与 HTTP 200 为准。
