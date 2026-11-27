# v107 代码审查 — 01

> 审查日期：2026-11-27
> 审查范围：相对 `6324cb9`（v106）的全部改动（跨四仓二次全面复审产出）
> 结论：**可发布**（无阻断）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 连线动画解耦与层级提升 | `src/App.tsx`、`src/components/EdgeInspectorPanel.tsx` | 显式 `strokeStyle` 不再隐式触发 `animated`；展开 `WidgetHistoryPopover` 时 `zIndex` 抬高至 `60` |
| 事件冒泡隔离 | `src/canvas/ControllableEdge.tsx` | 设置按钮阻断 `onDoubleClick` 向父级标签胶囊冒泡 |
| 单元测试 | `tests/uiComponents.test.ts` | 新增静态虚线不隐式开启流动动画断言，203/203 通过 |

## 审查发现

### 已确认正确

1. 旧版仅含 `dashed: true` 且无 `strokeStyle` 的连线仍保持原有动画与虚线兼容性，存量蓝图无破坏性影响。
2. 所有修改均在受控 React 状态与纯计算路径内完成，不引入额外重渲染抖动。

### 非阻断问题

1. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`，交由 CI 覆盖。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build:server`、`npm run build:mcp`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，203/203 通过。
