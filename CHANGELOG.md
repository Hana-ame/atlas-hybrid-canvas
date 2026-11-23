# Changelog

本项目记录 **Atlas Hybrid Canvas** 的架构演进、功能新增与工程化整改明细。

---

## [v21] — 工程化防坑整改（测试基建 / 模块拆分 / 存储与 Worker 加固 / 安全限流）

### 新增（Added）
- **前端与代理层自动化测试套件（P0）**：在 `package.json` 新增 `npm test`（`tsx --test tests/*.test.ts`），新增 5 份自动化测试共 13 条用例，覆盖：
  - `tests/crdt.test.ts`：`(rev, cid)` 确定性裁决、`computeRecordDiff` 与远端 CRDT 合并；
  - `tests/taskList.test.ts`：`- []` / `- [ ]` / `- [x]` / `- [X]` / 缩进子任务解析、切换与 Canvas 符号映射；
  - `tests/chunkManager.test.ts`：`512×512` 空间分块索引与视口裁剪；
  - `tests/proxySecurity.test.ts`：SSRF 内网 IPv4/IPv6/云元数据拦截、白名单校验与危险请求头拒绝；
  - `tests/scriptSandbox.test.ts`：危险全局词拦截、DAG 环路检测，以及**全量种子蓝图与内置模板脚本的语法/安全编译预检**。
- **独立领域 Hooks 拆分（P1）**：
  - `src/hooks/useBlueprintHistory.ts`：从 `src/App.tsx` 抽离 50 步深拷贝撤销/重做历史栈；
  - `src/hooks/useOverlaySync.ts`：从 `src/App.tsx` 抽离本地叠加层防抖写盘与多标签页同步生命周期。
- **有向无环图（DAG）环路检测（P3）**：`src/core/scriptSandbox.ts` 新增 `validateDagConnection()`，`App.tsx` 在 `onConnect` 拖线建边时自动拦截自环与传递环路，避免连线数据流循环触发。
- **即时脚本语法与安全预检（P3）**：`src/core/scriptSandbox.ts` 新增 `validateScriptSyntax()`，`src/components/NodeInspectorPanel.tsx` 在统一脚本编辑框下方实时展示安全拦截、语法报错或通过提示。
- **服务端 `/api/proxy` 限流与调用方鉴权（P2）**：`server/server.ts` 新增按 IP 滑动窗口限流（`PROXY_RATE_LIMIT_PER_MIN`，默认 30 次/分钟，返回 `429` 与 `Retry-After`）及可选 `X-Proxy-Token` 常量时间鉴权（`PROXY_CLIENT_TOKEN`），并同步更新 `.env.example`。

### 改进（Changed）
- **常驻可复用 Web Worker 池（P2）**：`src/core/scriptSandbox.ts` 不再在每次事件后销毁重建 Worker，改为最多复用 3 个空闲 Worker 并复用 Blob URL；仅在超时（>5s）或运行异常时立即强杀重建，消除链式连线触发时的冷启动与 GC 抖动。
- **IndexedDB 防抖写盘 + `BroadcastChannel` 跨页签同步（P2）**：`src/core/layeredStore.ts` 新增 `scheduleSaveLocalOverlay`（默认 300ms 防抖合并）、`flushLocalOverlaySave`（`beforeunload` / `pagehide` 兜底刷盘）与 `subscribeCrossTabOverlay`，避免打字高频全量写盘及多标签页静默覆盖。
- **离屏瓦片显存主动释放（P2）**：`src/core/chunkTileCache.ts` 在 LRU 淘汰与 `clear()` 时显式将离屏 `<canvas>` 的 `width` / `height` 置 `0`，主动回收图形缓冲区。
- **长内容控件内部滚动（P3）**：`src/canvas/WidgetNode.tsx` 主体区增加 `max-h-[420px] overflow-y-auto nowheel`，超长待办清单或动态块支持内部平滑滚动且不抢占画布滚轮缩放。

---

## [v19 – v20] — 连线数据通路与示例演示

### 新增（Added）
- **连线数据流脚本 API**：`PeerWidgetSnapshot` 暴露 `body` 正文；沙箱注入 `widgets.inputs(portId?)`、`widgets.outputs(portId?)`、`widgets.edges()` 与 `emitDownstream(event, payload, portId?)`。
- **上游变更自动刷新下游**：勾选上游复选框、编辑正文、执行上游脚本或建立/删除连线时，自动刷新所有连入下游的脚本控件。
- **ZONE D 三节点联动示例**：在 `src/core/seedBlueprint.ts` 新增「① 任务清单 → ② 数值发生器 → ③ 连线数据汇总」实时演示链路，同步更新 `docs/SCRIPT_API_GUIDE.md`。

### 修复（Fixed）
- **v20**：修复 `demo-flow-aggregator` 示例脚本在 TS 模板字符串中 `\n` 与正则转义被吞导致的 Worker 语法报错（改用 `String.raw` 并纳入自动化测试预检）。

---

## [v17 – v18] — 交互式待办复选框

### 新增（Added）
- `src/core/taskList.ts`：支持 `- []`、`- [ ]`、`- [x]`、`- [X]`、`* []`、`+ [ ]` 及缩进子任务解析与切换。
- `WidgetNode.tsx` 与 `AnnotationNode.tsx` 渲染自定义 SVG 复选框，**整行（方格与文字）均可直接点击切换**并持久化到 IndexedDB；底层 `ChunkUnderlayCanvas.tsx` 烘焙态同步渲染 `☐` / `☑`。

---

## [v16] — 生产级能力补齐

- **宏观缩放连线与箭头**：缩放低于 32% 切入 Canvas 宏观视图时直接绘制贝塞尔连线与箭头。
- **撤销 / 重做与框选多选**：50 步 `Ctrl+Z` / `Ctrl+Y` 历史栈与 `Shift` 拖框多选。
- **`Ctrl+K` 全局搜索与坐标深链接**：支持节点/注释模糊搜索、区块坐标直达与 `#chunk=cx,cy&zoom=z` 分享链接。
- **背景图等比自动压缩与 10MB 后端上限**：超过 180 KB 的背景图在浏览器端等比压缩至长边 ≤ 1280px。
- **JSON 导出 / 导入与 `ScriptTrustModal` 信任审计**：外部导入或远端同步脚本默认锁定，经用户审阅信任后方可运行。
- **WebSocket CRDT 协同房间客户端**：`src/core/roomClient.ts` 对接 `room-go/` 协议实现多端确定性合并。

---

## [v1 – v15] — 混合画布基础架构里程碑

- 融合 React Flow v12（`meso`/`micro` 原生 DOM 交互层）、AtlasCanvas（`512×512` 空间分块 + LRU 瓦片 + 迟滞 LOD + Worker 沙箱 + SSRF 代理）与 `room-go/`（Go 协同房间 + `(rev, cid)` CRDT）。
- 根治拖拽频闪（`applyNodeChanges` 保留 `measured`/`dragging` + `useStoreApi().subscribe()`），全量迁移至异步 IndexedDB，支持 `X-Blueprint-Save-Key` 保存鉴权、HiDPI 清晰背景字、0 入口/0 出口端口配置、右上角固定 Lock + 扁平无位移 hover 工具栏与完整架构文档集。
