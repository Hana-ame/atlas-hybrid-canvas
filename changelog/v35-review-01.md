# v35 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v35 相对 v34 的全部改动（三环裁剪预加载、分块精准脏缓存、连线裁剪与 PDF 离屏休眠）
> 结论：**可发布**，离屏卸载与方向预加载平衡合理，缓存粒度显著收敛，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/viewportCulling.ts` / `tests/viewportCulling.test.ts` | 新增三环包围盒、方向前瞻与连线裁剪及 3 条单测 | 纯函数边界清晰 |
| `src/core/chunkManager.ts` / `tests/chunkManager.test.ts` | 分块签名比对 + 1 条精准脏标记单测 | 未改区块 `version` 严格不变 |
| `src/canvas/ChunkUnderlayCanvas.tsx` | 空闲帧 `requestIdleCallback` 预烘焙（每次 ≤ 2 张） | 卸载与新帧自动 cancel，无抢帧 |
| `src/canvas/PdfViewerBlock.tsx` / `WidgetNode.tsx` | 接入 `mediaActive` 控制 `<iframe>` 离屏休眠 | 保留页码与总页数，近屏无缝恢复 |
| `src/App.tsx` | 接入三环预加载、连线裁剪、按需脚本渲染并移除全量清瓦片 | 压测大地图下 DOM 与 SVG 节点数大幅下降 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **预加载与裁剪无抖动**：`viewportBucketKey` 按 `256px` 步进量化，平移方向仅在位移 ≥ `128px` 时更新，不会因微颤反复挂载/卸载 DOM。
- **重媒体休眠不丢状态**：`PdfViewerBlock` 在 `mediaActive === false` 时卸载 `<iframe>`，但 `pdfUrl` / `pdfPage` / `pdfTotalPages` 均持久化在 `overlay.runtimeVars`，移回视口自动恢复原页码。
- **规范合规**：基于 v34 主仓基线演进，未改动历史 `changelog/` 文件，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：25 / 25 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-D-1-JKar.js`（`584969` 字节）。
