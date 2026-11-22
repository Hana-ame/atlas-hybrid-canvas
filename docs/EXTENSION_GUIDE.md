# 二次开发与扩展指南

## 一、如何新增一个内置模板

打开 `src/core/widgetTemplates.ts`，在 `BUILTIN_TEMPLATES` 数组中追加一项即可，左侧 `TemplateDrawer` 会自动渲染为所见即所得微缩卡片并支持直接拖入画布：

```ts
{
  id: 'tpl-my-custom',
  name: '我的业务节点',
  description: '一句话说明用途',
  group: '工程与运维', // 可选：'知识地图' | '策划与世界观' | '工程与运维' | '注释与基础'
  kind: 'node',       // 控件填 'node'，背景文本框/插图填 'annotation'
  color: '#0F766E',
  nodePreset: {
    width: 300,
    height: 180,
    title: '默认标题',
    body: '默认正文',
    category: 'CUSTOM',
    color: '#0F766E',
    defaultVars: { status: 'ready' },
    inputPorts: [{ id: 'in-1', label: '数据入' }, { id: 'in-2', label: '触发入' }],
    outputPorts: [{ id: 'out-1', label: '输出' }],
    buttons: [],
  },
}
```

## 二、如何新增一种自定义 React Flow 节点类型

1. 在 `src/core/types.ts` 的 `BlueprintNode` 上补充区分字段（例如 `nodeKind?: 'widget' | 'chart'`）；
2. 在 `src/canvas/` 新建一个用 `React.memo` 包裹的 React 组件（注意：交互表单元素务必加 `nodrag nopan nowheel` 并阻止 `onMouseDown` / `onPointerDown` 冒泡，其余区域保持可拖动）；
3. 在 `src/App.tsx` 的 `nodeTypes` 对象中注册该组件，并在同步 `rfNodes` 时根据 `entity.nodeKind` 分配 `type`；
4. 在 `src/canvas/ChunkUnderlayCanvas.tsx` 的 `if (p.lod === 'macro')` 分支中，按需为其定制全景瓦片下的简化色块外观（不定制也会自动沿用默认色块 + 大字标题）。

## 三、如何调整分区尺寸或 LOD 阈值

- **Chunk 网格尺寸**：默认为 `512`（定义在 `src/App.tsx` 的 `ChunkManager(512)`、`viewportBucketKey` 及 `seedBlueprint.ts` 的 `chunkSize`），大卡片场景可调大至 `1024`。
- **LOD 切换迟滞带**：在 `src/App.tsx` 的 `syncLod` 中修改 `0.32`（进全景瓦片）与 `0.38`（退回 DOM）两个阈值。
- **全景大字号**：在 `src/canvas/ChunkUnderlayCanvas.tsx` 中修改 `targetNodeScreenPx`（默认 `13.5`）与 `targetAnnScreenPx`（默认 `15`）。
