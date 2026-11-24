# v82 代码审查 — 02（通读补齐，覆盖范围修正）

> 审查日期：2026-11-24
> 审查基线：`2f67c89`
> 结论：**需修改**。本文件首先修正 `audit-2026-11-24-全仓库.md` 中「审查范围」的表述失真——那份把 `App.tsx` 的模式扫描写成了审查覆盖，实际未逐行通读。本文件给出真实覆盖清单，并补充通读后新发现的问题。

## 为什么单独建这份文件

`audit-2026-11-24-全仓库.md` 的表格里把 `src/App.tsx` 标为「精读房间切换/回档/发布/快捷键相关段落，未逐行通读」，但在同文件的「审查范围」首段又写了「全仓库 19,278 行源码」。**两处自相矛盾**：一段声称覆盖全仓，另一段承认 2,822 行未通读。这种写法会让读者误判审查强度。

按 AGENTS.md「历史文件只读」，不修改 `audit-2026-11-24-全仓库.md`，另建本文件更正。

## 本轮真实覆盖

### 已逐行通读（含全部 JSX 与控制流）

| 文件 | 行数 | 本轮新增 |
| :--- | ---: | :--- |
| `src/App.tsx` | 2,822 | ✅ 全文（1–2822） |
| `src/canvas/PdfViewerBlock.tsx` | 676 | ✅ 全文 |
| `src/canvas/ImageNodeBlock.tsx` | 229 | ✅ 全文 |
| `src/canvas/SliderControlBlock.tsx` | 108 | ✅ 全文 |
| `src/canvas/SmartNodeResizer.tsx` | 75 | ✅ 全文 |
| `src/core/apiPoller.ts` | 110 | ✅ 全文 |
| `server/fileStore.ts` | 439 | ✅ 全文（上轮已读） |
| `server/authSession.ts` | 121 | ✅ 全文 |
| `src/core/crdt.ts` / `edgeGraph.ts` / `roomPath.ts` / `roomClient.ts` / `webrtcMesh.ts` / `apiClient.ts` | 1,033 | ✅ 上轮已读 |

### 部分通读（关键逻辑段，非全文）

| 文件 | 行数 | 读到的范围 |
| :--- | ---: | :--- |
| `server/server.ts` | 1,111 | RPC handler、CORS、session、路由表、PDF 代理、rollback；**PDF 上传/分包路由尾部未读** |
| `server/roomServer.ts` | 719 | upsert、join、upgrade 鉴权、rtc 信令、持久化；**心跳与清扫段未逐行** |
| `server/pdfUnpack.ts` | 287 | 页数探测与渲染回落；**缓存与清理段未逐行** |
| `server/proxySecurity.ts` | 370 | `isPrivateOrReservedIP` 全文、allowlist；**头部清洗与 URL 校验细节未逐行** |
| `src/core/scriptSandbox.ts` | 767 | 黑名单、置空列表、worker 引导、执行与超时；**widgets/canvas API 实现段未逐行** |
| `src/canvas/contentBlockRegistry.tsx` | 500 | 注册表键与 pdf/api_poller/image/video 渲染器；**button/input/pad2d/image_button 渲染器未逐行** |
| `src/canvas/VideoNodeBlock.tsx` | 216 | 1–160 |
| `src/canvas/ImageButtonBlock.tsx` | 199 | 1–120 |
| `src/canvas/Pad2DControlBlock.tsx` | 296 | 40–160 |
| `src/canvas/AnnotationNode.tsx` | 348 | 1–120 |
| `src/core/chunkManager.ts` | 197 | 1–100 |
| `src/core/mockApi.ts` | 298 | browserDeps、forwardViaRpc、auth/session 直连、拦截器 |
| `src/core/apiCore.ts` | 482 | 路由表、rooms/history/rollback、publish 鉴权 |
| `src/core/layeredStore.ts` | 354 | storageKey、防抖写盘、跨页签订阅 |

### 尚未通读

| 文件 | 行数 |
| :--- | ---: |
| `src/core/seedBlueprint.ts` | 1,273 |
| `src/core/widgetTemplates.ts` | 790 |
| `src/canvas/WidgetNode.tsx` | 478 |
| `src/canvas/ApiPollerBlock.tsx` | 481 |
| `src/components/NodeInspectorPanel.tsx` | 556 |
| `src/components/TemplateDrawer.tsx` | 235 |
| `src/components/SearchJumpModal.tsx` | 188 |
| `src/components/ScriptTrustModal.tsx` | 106 |
| `src/components/CanvasErrorBoundary.tsx` | 91 |
| `src/core/types.ts` | 310 |
| `src/core/idbStorage.ts`（余下部分） | ~130 |
| `src/core/wid…`、`chunkTileCache` / `placement` / `viewportCulling` / `taskList` / `scriptAudit` / `pdfHelper` / `pdfClientUnpack` / `runtimeConfig` / `rpcClient` 余下 | ~1,100 |
| `tests/` 全量 | 3,200 |

**结论：本轮把最核心的 `App.tsx` 补齐了，全仓仍未读完。**上表「尚未通读」约 9,000 行，不能声称已审查。

---

## 本轮新发现

### P2-A　`appendProxyTokenQuery` 变成空操作，但 PDF 图片鉴权仍依赖它

**位置**：`src/core/apiClient.ts`（函数体直接 `return url`）、`src/canvas/PdfViewerBlock.tsx:98` 与 `:195`

```ts
// apiClient.ts
export function appendProxyTokenQuery(url: string): string {
  return url;
}

// PdfViewerBlock.tsx:97-98
const rawServerImageSrc = buildPdfPageImageUrl(url, safePage, activeDpi);
const serverImageSrc = rawServerImageSrc ? appendProxyTokenQuery(rawServerImageSrc) : null;
```

v75 为了消除 URL 令牌泄露，把该函数改成恒等返回，同时服务端改为同时接受 `atlas_session` Cookie。同源部署下 `<img>` 会自动带 Cookie，功能正常。

问题在**跨源部署**：前端在 `pages.example`、后端在 `api.example`，`<img src="https://api.example/api/pdf/...">` 属于跨源请求，Cookie 受 `SameSite=Strict` 限制不会被发送，而 URL 又不再带令牌 → **图片 401，PDF 页永远显示"加载失败"**。

调用点保留了 `appendProxyTokenQuery(...)` 的写法，读代码的人会以为"这里已经处理了鉴权"。实际是空调用。

**影响面**：仅跨源自托管部署；同源与纯静态模式无影响。

**处理动作**：未改。建议删除该函数与两处调用，改为显式注释「同源依赖 Cookie，跨源请由后端提供签名 URL」；或恢复为一次性短时效签名 URL（而非长期 bearer）。

### P2-B　`PdfViewerBlock` 卸载时不释放前端解包文档

**位置**：`src/canvas/PdfViewerBlock.tsx`，`disposeClientPdfDoc` 仅在 `:326` 与 `:399` 的 `!mountedRef.current` 分支调用

正常卸载路径（删除节点、切换房间导致 `setBase` 整体替换、控件被 React 卸载）**没有** `useEffect` 清理调用 `disposeClientPdfDoc(clientDocId)`。`clientDocStore` 里的文档与其 `pageCache` 会保留到 LRU 顶掉（`MAX_CLIENT_DOCS = 3`）为止。

**影响面**：本地内存占用，最坏 3 份文档 × 4 页热图。不崩溃。

**处理动作**：未改。建议补 `useEffect(() => () => { if (clientDocId) disposeClientPdfDoc(clientDocId); }, [clientDocId])`。

### P3-A　`handleRunButton` 的 `proxy_http` 分支不检查 `resp.ok`

**位置**：`src/App.tsx:790-808`

```ts
const resp = await fetch('/api/proxy', {...});
const data = (await resp.json()) as { ok: boolean; status?: number; error?: string };
```

401/413/502 返回的是 JSON，能解析；但若中间层返回 HTML 错误页，`resp.json()` 抛错，异常冒泡到 `finally` 之外——外层没有 try/catch，只会被 React 的 console 捕获，用户看不到任何提示，`busyButtonKey` 因 `finally` 被清空，表现是"点了没反应"。

**处理动作**：未改。

### P3-B　`App.tsx` 的 `renderedScriptsRef` 在使用点之后声明

**位置**：`:380-383` 的 `bumpChunkSyncTick` 引用了 `:415` 才 `const` 声明的 `renderedScriptsRef`

`useCallback` 的函数体延后执行，所以运行时不会命中 TDZ。但只要有人在渲染期调用 `bumpChunkSyncTick`（例如新的 `useMemo` 里），就会抛 `Cannot access 'renderedScriptsRef' before initialization`。这是可读性与未来改动风险，不是现存 bug。

**处理动作**：未改。建议把 ref 声明上移到所有使用点之前。

### P3-C　`useOverlaySync` 依赖两个 effect 的执行顺序

**位置**：`src/hooks/useOverlaySync.ts:37-43`（重置 `hydratedInitRef`）与 `:46-59`（建立指纹基线）

房间切换时，第一个 effect 把 `hydratedInitRef` 置 false，第二个 effect 同轮执行并走"建基线直接 return"分支，避免把空 overlay 写盘。当前顺序正确，但**正确性依赖 effect 声明顺序**，任何人重排两个 effect 就会导致切房间时把空 overlay 覆盖到新房间。

**处理动作**：未改。建议合并为一个 effect，把重置逻辑内联在房间变化判断里。

### P3-D　`SliderControlBlock` 的 `onKeyUp` 会把任意按键当作提交

**位置**：`src/canvas/SliderControlBlock.tsx:90-93`

`onKeyUp` 无按键过滤，Tab、Shift、Escape 都会触发 `onCommit`，进而 `pushHistory()`。用键盘 Tab 遍历控件会向撤销栈塞入无意义的空快照。

**处理动作**：未改。建议只对 `Arrow*`、`Home`、`End`、`PageUp/Down` 提交。

### P3-E　`AnnotationNode` 的图片 URL 草稿不与外部变更同步

**位置**：`src/canvas/AnnotationNode.tsx:39`

```ts
const [imageUrlDraft, setImageUrlDraft] = useState(annotation.imageUrl || '');
```

只在首次挂载初始化。若脚本通过 `canvas.setAnnotationImage()` 改了背景图，或协同方更新了 `imageUrl`，再点"换图"时草稿仍是旧值，提交会把对端/脚本刚设的图覆盖回旧链接。

**处理动作**：未改。建议加 `useEffect(() => setImageUrlDraft(annotation.imageUrl || ''), [annotation.imageUrl])`，或在打开编辑态时用当前值初始化。

### P3-F　`handleSpawnStress` 的 `setTimeout` 未清理

**位置**：`src/App.tsx:2279`

```ts
setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 80);
```

80ms 内组件卸载会在已卸载的 React Flow 实例上调用 `fitView`。无实际危害（React Flow 内部有防护），但属未清理定时器。

**处理动作**：未改。

---

## 前两份报告的结论仍然有效

本文件不推翻也不重复：

- `v82-review-01.md`：2×P0（空 Origin 签发令牌、Origin 可伪造）、3×P1（XFF 限流绕过、proxy 与会话令牌共用鉴权、静态模式不分房）、4×P2、7×P3 —— **全部仍然存在**，v82 之后没有修复提交。
- `audit-2026-11-24-全仓库.md`：1×P1（沙箱嵌套 Worker 逃逸）、4×P3 —— 仍然存在。其中「审查范围」表述失真由本文件更正，技术结论不变。

---

## 验证记录

| 项 | 结果 |
| :--- | :--- |
| CI | `45377978575` success · `45377978596` deploy success |
| 测试 | 131 / 131 通过（`# fail 0`） |
| 本机构建 | 未执行（AGENTS.md 禁止） |

**本轮为阅读型审查，未产生代码改动，因此 CI 状态与上一提交相同。** 这不构成对上述发现的验证——7 条新发现全部不在测试覆盖范围内。

---

## 后续

剩余约 9,000 行（`seedBlueprint` / `widgetTemplates` / `WidgetNode` / `ApiPollerBlock` / `NodeInspectorPanel` / `TemplateDrawer` / `SearchJumpModal` / `ScriptTrustModal` / `CanvasErrorBoundary` / `types` / 若干 `src/core` 工具与 `tests`）按同样的逐行方式继续，每完成一批新建 `v82-review-03.md`，不修改本文件。

在全部读完之前，任何"整个仓库已审查"的表述都不成立。
