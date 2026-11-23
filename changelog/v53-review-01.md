# v53 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：`src/canvas/WidgetNode.tsx`、`src/canvas/AnnotationNode.tsx`
> 结论：**通过**

## 核验要点

- **零写盘与零历史栈膨胀**：`onResize` 仅更新节点组件局部 `liveSize` state，不触发 `onResizeNode` / `onUpdateAnnotation`；仅 `onResizeEnd` 提交最终尺寸。
- **PDF 控件与普通控件一致体验**：拉伸期间 `height` 实时切换为 `displayHeight`，PDF 控件内 `ResizeObserver` 同步感知最新尺寸并在松手/停顿后自动拉高 DPI，全程所见即所得。
