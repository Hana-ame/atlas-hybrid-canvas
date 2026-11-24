# 质量保障、对抗性审查与 Changelog 闭环流程手册

> 建立日期：2026-11-24
> 适用范围：Atlas Hybrid Canvas 全仓开发、合并、代码审查、测试门禁与发布打包

## 一、核心原则（先说底线）

1. **单靠“测试全绿”不等于“没有 Bug”**：正向测试只证明写过的路径能跑通，无法证明安全边界、并发竞态或畸形输入没有漏洞。
2. **历史上真实踩过的坑，必须变成自动化负向测试 + CI 门禁**：否则后续重构随时会悄悄回退（例如 v75 修过的鉴权在 v79 重构时回退，v87 写完 Agent 接口后仍存在未落盘 WS 覆盖、畸形 `%ZZ` 编码异常等）。
3. **审查与发布分离、历史只读**：严格遵守 `AGENTS.md`，每次版本迭代新建 `changelog/vNN.md`，每次审查新建独立 `changelog/vNN-review-MM.md`，永不覆盖、永不删改历史审查记录。

---

## 二、五步防 Bug 闭环流程

### 第 1 步：P0 / P1 一律走「先红测试 → 再修绿 → 再关单」

- 凡是 `vNN-review-MM.md` 中确认的 P0 / P1 问题，下一版 `v(NN+1).md` **必须一一对应列出**：
  1. 根因与修复文件/行号；
  2. 新增的对抗性负向测试名称（证明“不修就会挂”）；
  3. 实际运行结果（严禁用 `| tail` 掩盖测试进程退出码）。
- 没有对应回归测试的修复，不算完成关单。

### 第 2 步：每次增量审查必须诚实分三栏记录

每份 `changelog/vNN-review-MM.md` 必须拆成三栏，避免把“局部扫描”或“单测通过”夸大成“全仓无误”：

| 栏目 | 必须写清的内容 |
| :--- | :--- |
| **已逐行阅读范围** | 精确到文件名与行号区间（只针对相对上一版的 diff 或明确声明的模块） |
| **实际执行过的验证** | 确切命令、退出码、通过/失败数、是否实启了真后端进程或子进程 |
| **当前未覆盖的盲区** | 明确列出尚未实机验证的环境（如真实浏览器拖拽/IndexedDB 游标、远端 GitHub Actions、真实 `docker build`） |

### 第 3 步：高风险改动必查「五项坏输入与竞态清单」

凡改动涉及**路由、鉴权、并发、外部输入、构建脚本**，提交前必须逐条做对抗性自检：

1. **缺头 / 空值 / 越权**：不带 `Origin`、不带 Token、仅带匿名会话 Cookie 访问高权限接口（`/api/proxy`、`/api/rooms/*/ops`、`/api/rooms/*/rollback`）是否一律返回 `401` / `403`？
2. **畸形编码 / 恶意载荷**：路径中含 `%ZZ`、`%E0%A4%A`、`../`、非 JSON 请求体、超大体积、`blocks` 内嵌 `javascript:` / `blob:` URL 是否全部拦截并返回 `400` / `413` 而不抛未捕获异常？
3. **伪造来源头与限流**：`TRUST_PROXY` 未显式开启时，伪造不同 `X-Forwarded-For` 是否依然触发 `429`？
4. **并发与时序竞态**：
   - WS 1.5 秒防抖窗口内人类刚编辑的节点，Agent 立即读写会不会覆盖？
   - WS 首次异步磁盘水合尚未完成时，`flushRoomSnapshot` 会不会返回空快照遮蔽磁盘数据？
   - 并发 `/ops` 与 `/rollback` 是否进了同一把按房间串行锁（`runSerializedForRoom`）？
5. **CI 与构建产物一致性**：新增了被 E2E 启动的打包产物（如 `dist-server/server.mjs`、`dist-server/mcp-server.mjs`）或系统二进制依赖（如 `poppler-utils`）时，`.github/workflows/ci.yml` 与 `deploy-pages.yml` 是否同步前置了对应构建与安装步骤？

### 第 4 步：本地与 CI 统一质量门禁顺序

推送或打包前，严格按以下顺序执行（全部要求退出码为 `0`）：

```bash
npm run typecheck                           # 1. 零排除全仓 tsc --noEmit
npm run build:server && npm run build:mcp   # 2. 先构建真后端与 MCP 产物（E2E 依赖）
node --check dist-server/server.mjs         # 3. 校验服务端产物语法
node --check dist-server/mcp-server.mjs     # 4. 校验 MCP 产物语法
npm test                                    # 5. 全量单测 + WS + 真进程 E2E + 实进程 stdio MCP
npm run build                               # 6. 前端 Vite 生产分包构建
```

### 第 5 步：补齐沙箱之外的两项实机烟测（发版前清单）

在本地机器或独立 CI Job 中定期执行以下两项沙箱无法替代的实机验证：

1. **真实浏览器烟测（Playwright 或手工）**：打开画布 → 拖拽节点/滑块 → 切换多级房间路径 → 离线刷新恢复 → 双页签跨页签同步 → 触发一次 Agent 操作观察实时渲染 → 点击一键回档恢复。
2. **容器与外部 MCP 客户端烟测**：执行一次真实 `docker build` + `/api/health` 探针，并用真实 MCP 客户端（Claude Desktop / Cursor / Gemini CLI）挂载 `dist-server/mcp-server.mjs` 跑通 `atlas_inspect_room` → `atlas_apply_ops` → `atlas_rollback_room`。

---

## 三、案例归档：v87 → v88 → v89 对抗性复查实战记录

以下记录完整保留了本轮从“快速写完 v87”到“自查补全 v88”再到“对抗性复查抓出 4 个边界 Bug 并修完 v89”的全过程，作为后续审查的对照样本：

### 1. v87 初版暴露出的 5 处能力短板（已在 v88 补齐）

1. **缺少 Agent 专用只读接口**：原 `GET /api/rooms/*/blueprint` 仅认浏览器会话令牌，只持 `X-Agent-Api-Key` 的 Agent 无法先读房间状态。→ v88 新增 `GET /api/rooms/*/agent/state` 与 `GET /api/agent/state`，并让 `/api/rooms/*/rollback` 接受 `X-Agent-Api-Key`。
2. **并发覆盖人类未落盘 WS 编辑**：原 `/ops` 直接读盘快照并 `replace: true`，会冲掉 1.5 秒防抖窗口内的人类实时修改，且无版本冲突检测。→ v88 新增 `roomServer.flushRoomSnapshot()`、按房间串行队列 `runSerializedForRoom` 与 `expectedRevision` 乐观锁（冲突返回 `409 Conflict`）。
3. **缺少模板与结构化积木创建**：原接口需 Agent 手写原始 `defaultVars` / `script`。→ v88 新增 `create_from_template`（复用全部 22 套 `BUILTIN_TEMPLATES`）与 `blocks` 结构化积木字段。
4. **缺少开箱即用的 MCP 服务端**：原仅提供 `/api/agent/schema` JSON。→ v88 新增零依赖 JSON-RPC 2.0 stdio MCP 服务端 `server/mcpServer.ts` 与 `npm run build:mcp`。
5. **缺少 `dryRun` 预演**：原无法在不写盘的情况下预览自动布局坐标。→ v88 支持 `dryRun: true` 返回 `bounds` 与 `preview`。

### 2. v88 在 151/151 测试全绿状态下，逐行对抗性复查抓出的 4 个真实 Bug + 1 个 CI 隐患（已在 v89 修复并锁死）

1. **畸形 URL 编码未捕获异常（`server/server.ts`）**：`decodeURIComponent(raw)` 未包 `try/catch`，发 `%ZZ` 或 `%E0%A4%A` 会在 Express 4 `async` 路由里抛未捕获 `URIError`。→ v89 封装 `safeDecodeRoomParam()` 直接返回 `400`，并补负向 E2E 用例。
2. **WS 首次异步水合窗口期空快照竞态（`server/roomServer.ts`）**：`flushRoomSnapshot` 未判断 `hydratedRooms.has(roomName) || persistTimers.has(roomName)`，可能返回刚初始化的空 `RoomState` 遮蔽磁盘蓝图。→ v89 补齐守卫。
3. **`blocks` 结构化积木漏校验危险 URL（`src/core/agentOps.ts`）**：未逐块拦截 `image` / `video` / `pdf` / `api_poller` / `image_button` 中的 `javascript:` / `blob:` URL。→ v89 新增 `validateBlocksSafety()` 并补负向单测。
4. **回档路由未进同一把房间串行锁（`server/server.ts`）**：`handleRollbackRequest` 未进 `runSerializedForRoom(roomPath)`，与并发 `/ops` 存在写盘交错。→ v89 统一串行化。
5. **CI 漏前置 `build:mcp`（`.github/workflows/ci.yml`、`deploy-pages.yml`）**：实进程 stdio MCP E2E 测试会 `spawn dist-server/mcp-server.mjs`，若 CI 不先跑 `npm run build:mcp` 会直接 `ENOENT`。→ v89 已同步更新两份工作流，全量测试通过 **153/153**。
