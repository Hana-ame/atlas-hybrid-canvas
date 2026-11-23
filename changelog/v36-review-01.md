# v36 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v35 相对 v34 的全部改动（三环视锥裁剪、方向预测预加载、分块签名脏缓存、连线裁剪、PDF 离屏休眠），以及本版补充的修复
> 结论：**需修改后发布**（已在本版内修复）。上游 `v35-review-01.md` 判「可发布、无阻断问题」，其中「空闲帧预烘焙……无抢帧」的判断**与实现不符**，且未注意到分块签名漏字段。

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/viewportCulling.ts` | 新增，81 行纯函数：三环包围盒、连线裁剪 | 边界正确，24 项断言全通过 |
| `src/core/chunkManager.ts` | 分块级内容签名，`version`/`dirty` 按签名比对决定 | 签名字段不全，已补 |
| `src/canvas/ChunkUnderlayCanvas.tsx` | `requestIdleCallback` 空闲预烘焙 | 排程策略有缺陷，已修 |
| `src/canvas/PdfViewerBlock.tsx` | 新增 `mediaActive` 控制 iframe 挂载 | 干净，默认 `true` 有兜底 |
| `src/App.tsx` | 接入三环、连线裁剪、按需脚本渲染 | 基础逻辑正确，有一处渲染期副作用 |
| `tests/viewportCulling.test.ts` / `chunkManager.test.ts` | 新增 4 条用例 | 覆盖面偏窄，未测 Ring 0 方向偏移与签名漏字段 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合保护清单 |

## 审查发现

### 已确认正确

- **三环嵌套在所有方向下成立**：7 种平移方向组合逐一验证 `Ring0 ⊆ Ring1 ⊆ Ring2`，均成立。
- **绝对偏移与注释一致**：无方向时 Ring 0 pad = 320、Ring 1 = 512、Ring 2 = 1024，与文件头注释的「320px / 1 Chunk / 2 Chunk」严格对应。
- **方向前瞻按轴向独立分配**：右移时 Ring 1 右扩 1024、左扩 512；Ring 0 右侧额外 256、左侧无额外（`Math.round(512 * 0.5)`）。对角线方向（`[1,1]`、`[-1,-1]`）也正确组合。
- **`chunkSize` 联动正确**：传 256 时 Ring 1 pad = 256、Ring 2 pad = 512，无硬编码残留。
- **`isBoxIntersecting` 边界闭合**：用 `<=`/`>=` 而非 `<`/`>`，相接即算相交，适配瓦片网格。
- **PDF 休眠不丢状态**：`mediaActive` 默认 `true`，未传即常挂载，不会误伤未接入的位置；`pdfUrl`/`pdfPage`/`pdfTotalPages` 存于 `overlay.runtimeVars`，恢复时自动回原页码。
- **`filterVisibleEdges` 语义正确**：一端可见即保留，避免连线在视口边缘突兀消失。
- **v29–v34 修复零回退**：`express.raw`、`mergedEmits`、`uniqueOutputs`、`targetIds`、`PDF_UPLOAD_MAX_BYTES`、LRU `delete+set` 全部在位。这版上游确实基于 v34 演进，没有像 v31/v32 那样丢失既有修复。
- **`lod === 'macro'` 时清空边渲染**不是本版引入：v34 的 `App.tsx:1406` 已有同样判断。

### 非阻断问题

1. **`prevViewportCenterRef` 在 `useMemo` 内被赋值**
   - 位置：`App.tsx:202` 的 `threeRingBounds` 计算。
   - 影响面：平移方向前瞻偶发取到上一次的值，最多导致预加载偏移一格，不影响正确性。
   - 成因：`useMemo` 不保证只执行一次（StrictMode 双调用、依赖变更重算），在其中写 ref 属渲染期副作用，不幂等。
   - 处理动作：**未改**。彻底修需把方向判定移出 `useMemo` 改用 `useRef` + 显式比较，改动面超出本次合并范围，记入已知遗留。

2. **新增单测覆盖面偏窄**
   - 影响面：无运行时影响，属回归风险。
   - 内容：`viewportCulling.test.ts` 只测了一个方向的 Ring 1 前瞻，未覆盖 Ring 0 偏移、Ring 2、对角线方向、自定义 `chunkSize`；`chunkManager.test.ts` 的脏标记用例未覆盖「改 `body` 但不动几何」这类字段级改动。
   - 处理动作：**未补测试**（`AGENTS.md` 禁止本地跑 `npm test`，新增用例无法在此验证）。已用一次性断言脚本在合并前验证 24 + 15 项，结论记入 `v36.md` 验证段。

3. **`renderedScriptsRef` 语义依赖外部清理**
   - 影响面：潜在，当前无触发路径。
   - 内容：首帧脚本按 Ring 1 过滤渲染，`renderedScriptsRef` 记录已渲染 id；v35 保留了 v34 的四处 `clear()`，但若将来新增节点删除路径未同步清理，同 id 重建会被跳过。
   - 处理动作：**未改**，记入已知遗留。

### 阻断问题

1. **分块签名漏掉节点渲染字段**（已修）
   - 位置：`src/core/chunkManager.ts` 的签名构造。
   - 影响面：全量用户可见——改节点 `body` / `category` / `locked` 后，离屏瓦片不刷新，显示旧画面。
   - 成因：签名只含 `id/x/y/width/height/color/title`。这些字段不变时签名相同 → 走 `rec.version = prev.version; rec.dirty = prev.dirty` → `ChunkTileCache.get()` 的 `existing.version === chunk.version && !chunk.dirty` 成立 → 直接命中旧瓦片。
   - 修复：补齐 `body`（计长度）、`category`、`locked`（计布尔位）。虽当前瓦片只绘制 `title`，但签名与绘制字段解耦是隐患——将来若在瓦片上多画一行正文，就会静默失效。

2. **annotation 签名只取前 32 字符**（已修）
   - 位置：同上，`a.text.slice(0, 32)`。
   - 影响面：长文本注释改后半段时瓦片不刷新。
   - 成因：`slice(0, 32)` 对第 33 字符之后的改动完全不敏感。已验证：构造 60 字符文本，把第 56–60 字符改掉，旧签名**完全不变**。
   - 修复：补 `text.slice(-16)` 作为尾部指纹，配合原有长度校验。

3. **空闲预取被反复取消，实际不生效**（已修）
   - 位置：`src/canvas/ChunkUnderlayCanvas.tsx` 的 `scheduleIdleTilePrefetch()`。
   - 影响面：Ring 2 预烘焙这一整层优化形同虚设；用户感知为「平移时周边瓦片仍然要现烧」，卡顿没有改善。
   - 成因：`scheduleIdleTilePrefetch` 被放在 `draw()` 末尾无条件调用，而 `draw()` 在平移/拖拽期间近乎每帧触发（`store.subscribe` → `draw(false)`，加上 `hasPendingBakes` 时的 `requestAnimationFrame` 自递归 `draw(true)`）。原实现每次进入都先 `cancelIdlePrefetch()` 再重排，`requestIdleCallback` 的 `timeout: 120` 永远等不到——上一个还没跑就被下一个取消。
   - 上游审查结论「卸载与新帧自动 cancel，无抢帧」正是把这个缺陷当成了特性：cancel 是真的在 cancel，但代价是预取从不执行。
   - 修复：改为「`idleHandle !== null` 时直接 return」，让已排程的预取跑完；`runPrefetch` 内部仍用排程时的 bounds，失败由 `propsRef.current` 保证读到最新数据。卸载时（effect cleanup）的 `cancelIdlePrefetch()` 保留。

## 验证记录

- **三环边界 24 项断言**：7 种方向 × 2 项嵌套关系 + 3 项绝对偏移 + 4 项右移偏移 + 1 项零尺寸视口 + 2 项 `chunkSize=256` 联动，**全部 PASS**。
- **签名覆盖度 15 项断言**：节点 9 个字段任一改动均改变签名；annotation 尾部字符、长度、位置、颜色均被捕获；未改动时签名一致。**全部 PASS**。对照验证旧实现在「第 56 字符起改动」时**漏检**。
- **v29–v34 修复零回退**：`express.raw` ×4、`mergedEmits` ×8、`uniqueOutputs` ×3、`targetIds` ×5、`PDF_UPLOAD_MAX_BYTES` ×5、LRU `delete(id)` ×1。
- **语法检查**：`src/core/chunkManager.ts`、`src/core/viewportCulling.ts` 通过 Node 类型剥离解析。
- **改动范围**：6 个修改文件 + 2 个新增文件 + 2 份 changelog，未触及 `vite.config.ts`、`package.json`、`AGENTS.md`。
- **保护文件**：`.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 零改动。
- **版本号**：交付物自带 v35 记录，与仓库既有 v29–v34 无冲突，直接沿用；本版修复记为 v36。
- `npm test` / `npm run typecheck` / `npm run build`：由 CI 执行，本机不跑（`AGENTS.md` 禁止本地构建）。
