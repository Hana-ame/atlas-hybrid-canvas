# v88 代码审查 — 01（v87/v88 新增代码对抗性复查）

> 审查日期：2026-11-24
> 审查对象：v87–v88 新增的 `src/core/agentOps.ts`、`server/mcpServer.ts`、`server/server.ts` Agent 路由与 `server/roomServer.ts` `flushRoomSnapshot`
> 结论：**需修改**。151 项测试全绿，但逐行对抗性复查发现 4 处边界缺陷与 1 处测试盲区（MCP 未实启 stdio 子进程）。

## 发现列表

1. **P1 · 畸形 URL 编码未捕获异常（`server/server.ts:868`、`:953`）**：`decodeURIComponent(raw)` 未包 `try/catch`，发送 `%ZZ` 或 `%E0%A4%A` 会在 Express 4 `async` 路由中抛未捕获 `URIError`。
2. **P1 · WS 首次异步水合窗口期空快照竞态（`server/roomServer.ts:683-700`）**：`flushRoomSnapshot` 未判断 `hydratedRooms.has(roomName) || persistTimers.has(roomName)`，刚建房尚未水合完成时可能返回空快照遮蔽磁盘数据。
3. **P1 · `blocks` 结构化积木漏校验媒体 URL（`src/core/agentOps.ts`）**：`create_widget` / `update_widget` 直接透传 `blocks` 至 `defaultVars.contents`，未逐块拦截 `javascript:` / `blob:` 等不安全 URL。
4. **P2 · 回档路由未接入房间串行队列（`server/server.ts:957`）**：`handleRollbackRequest` 未进 `runSerializedForRoom(roomPath)`，与并发 `/ops` 存在写盘交错窗口。
5. **测试盲区**：`tests/mcpServer.test.ts` 仅函数级直调，未真实 `spawn` `dist-server/mcp-server.mjs` 走 stdin/stdout JSON-RPC 管道。
