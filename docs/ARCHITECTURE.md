# 系统架构与工程防坑手册

本文档说明 **Atlas Hybrid Canvas** 的混合渲染管线、双层状态模型以及几个最关键的性能与稳定性工程决策。

## 一、混合渲染架构：为什么同时用 React Flow 和 Canvas 2D？

纯 DOM 节点图（如原生 React Flow）在放大精编时拥有无敌的表单/输入法/组件生态，但缩远至全景同时看到几百上千节点时会触发严重 DOM 重排卡顿；纯 Canvas 2D 则相反，缩远性能极强，但每新增一个输入框、下拉菜单或颜色选择器都需要手写几何排版和焦点管理。

本框架采用**按 LOD 动静分离的混合双层渲染**：

1. **近景精编（`micro`，`zoom >= 0.72`）与中景浏览（`meso`，`0.32 <= zoom < 0.72`）**：
   - 上层 React Flow **仅挂载当前视口可见 Chunk 网格内的节点**；
   - 底层 `ChunkUnderlayCanvas` 负责绘制 `512×512` 无限网格与**锁定态的背景文本框/插图（离屏瓦片缓存，点击完全穿透）**。
2. **全景瓦片（`macro`，`zoom < 0.32`）**：
   - 上层 React Flow 自动切为空数组 `rfNodes = []`（**0 个 DOM 节点挂载**）；
   - 底层 `ChunkUnderlayCanvas` 接管全部节点的简化色块绘制（烘焙进 `ChunkTileCache` 离屏瓦片），并在瓦片之上按屏幕像素恒定补偿绘制清晰的截断大字标题（约 `13.5px` 节点标题 + `15px` 区域标牌，带白描边）。

## 二、四大核心防频闪与性能工程决策

### 1. 迟滞区间 LOD（Hysteresis）
为避免用户在 `35%` 临界点微调滚轮时在 DOM 与瓦片之间反复闪切，LOD 切换采用迟滞带：
- 缩小时：`zoom < 0.32` 才切入 `macro`；
- 放大时：`zoom > 0.38` 才切回 `meso` / `micro`。

### 2. 底层 Canvas 通过 Zustand 订阅实现零 React 重渲染
`ChunkUnderlayCanvas` **严禁调用 `useViewport()`**。它通过 `useStoreApi().subscribe()` 直接监听 React Flow 内部的 `transform: [tx, ty, zoom]`，在 `d3-zoom` 修改 DOM `translate3d` 的同一同步时机重绘 `<canvas>`，并采用与 React Flow 完全一致的左上角矩阵变换：

```ts
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.translate(tx, ty);
ctx.scale(zoom, zoom);
```

同时，顶层 `App.tsx` 也不直接订阅 `transform`，而是通过 `useStore` 选择器只订阅粗粒度整数网格键 `viewportBucketKey = "${minCx},${maxCx},${minCy},${maxCy}"`。只要平移没有跨越新的 Chunk 边界，整个 `App` 组件树零重渲染。

### 3. React Flow v12 拖动节点防“消失重现”原则
在 `@xyflow/react` v12 中，任何丢失了内部 `measured: { width, height }` 属性的受控节点都会被暂时置为 `visibility: hidden` 等待 `ResizeObserver` 重测。因此：
- 必须维护受控状态 `[rfNodes, setRfNodes]` 并在 `onNodesChange` 中调用 `applyNodeChanges(changes, prev)`；
- **拖拽进行中（`dragging === true`）绝不重建节点对象、绝不清空 `tileCache`、绝不写入 `overlay`**；
- 仅在拖拽松手（`dragging === false`）时，一次性将最终整数坐标写回 `overlay.nodePatches` 并刷新 Chunk 空间索引；
- 增删动态端口（`inputPorts` / `outputPorts`）或缩放节点尺寸后，在 `WidgetNode` 中调用 `useUpdateNodeInternals(entity.id)` 通知 React Flow 刷新 Handle 锚点坐标。

### 4. 单帧瓦片烘焙预算
`ChunkUnderlayCanvas` 每帧限制最多烘焙 `MAX_BAKES_PER_FRAME = 6` 块离屏瓦片或累计耗时 `< 6ms`。超预算分区先沿用旧瓦片并调度下一帧 `requestAnimationFrame` 渐进补烘，确保拖拽与缩放始终稳定高帧率。

## 三、双层状态模型：权威底座 + 个人本地叠加层

```text
EffectiveNode       = merge(BaseBlueprint.nodes[id], LocalOverlay.nodePatches[id])
EffectiveVars       = { ...BaseNode.defaultVars, ...LocalOverlay.runtimeVars[id] }
EffectiveAnnotation = merge(BaseBlueprint.annotations[id], LocalOverlay.annotationOverrides[id])
```

- **BaseBlueprint（权威底座）**：存放经管理员审核的蓝图结构、默认变量 `defaultVars` 与背景注释，通过带密钥鉴权的 `POST /api/blueprint/publish` 持久化到后端。
- **LocalOverlay（个人本地叠加层）**：存放当前用户在浏览器里拖动的位置、改写的文案、按钮脚本产出的 `runtimeVars` 以及脚本触发的背景变色 `annotationOverrides`。全部以**字段级稀疏补丁**形式异步持久化在 **IndexedDB（`atlas-hybrid-canvas-db`）** 中：
  - 后端升级了某节点的新脚本或新按钮时，只要本地补丁没改那个字段，新架构就会自动生效；
  - 后端删除了某节点时，`resolveEffectiveNodes` 自动过滤孤儿本地缓存；
  - 用户可随时单节点或全局一键「重置本地」，无损回到后端基线。
