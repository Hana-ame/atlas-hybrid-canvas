# v104 代码审查 — 01

> 审查日期：2026-11-27
> 审查范围：相对 `3a0ff37`（v103）的全部改动
> 结论：**可发布**（无阻断）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 类型与路径几何 | `src/core/types.ts`、`src/core/edgePath.ts` | 新增 `EdgeStrokeStyle`、`EdgePathType`，`buildControlPointEdgePath` 支持平滑/直线/折线与控制点 |
| 连线渲染与入口 | `src/canvas/ControllableEdge.tsx` | 尊重自定义 `strokeWidth` 与 `strokeDasharray`，选中态提供设置齿轮按钮 |
| 设置面板与联动 | `src/components/EdgeInspectorPanel.tsx`、`src/App.tsx` | 按需分包面板，与节点检查/版本历史抽屉互斥，变更纳入 `pushHistory` 与 `rev` 递增 |
| 单元测试 | `tests/uiComponents.test.ts` | 覆盖线型、路径、自定义颜色/虚线与设置面板渲染，201/201 通过 |

## 审查发现

### 已确认正确

1. **向后兼容**：未设置 `strokeStyle` 或 `animated` 的旧蓝图连线仍按原有 `dashed` 字段回退渲染，不破坏存量数据。
2. **协同与撤销一致性**：`handleUpdateEdge` 与 `handleDeleteEdgeById` 均调用 `pushHistory()` 并递增 `edge.rev` 与 `base.version`，支持本地撤销/重做与多人协同同步。

### 非阻断问题

1. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，201/201 通过。
