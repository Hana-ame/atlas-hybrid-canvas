# v100 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：相对 `d2f69eb`（v99）的全部改动
> 结论：**可发布**（无阻断；点击按钮或变量更新时不再引发布局抖动）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 卡片与按钮渲染 | `src/canvas/WidgetNode.tsx`、`src/canvas/contentBlockRegistry.tsx` | 忙态保留原标签只切换 `Loader2`；按钮与变量区高度彻底解耦 |
| 样式与测试 | `src/index.css`、`tests/uiComponents.test.ts` | 新增 `.vars-scroll-row` 细滚动条样式与单行横滚断言 |

## 审查发现

### 已确认正确

1. **按钮尺寸与位置零跳变**：无论是否处于 `isBusy`，按钮文字与尺寸完全恒定；常规正文去掉 `flex-1` 并由固定高度 `h-8` 底部栏承载变量展示，按钮位置不再因变量从无到有或 JSON 变长而上移或重排。
2. **单行横滚与画布交互隔离**：变量胶囊均带 `shrink-0 select-text whitespace-nowrap`，变量行带 `nodrag nopan nowheel` 并支持垂直滚轮转横向滚动，兼顾长值查阅与画布防误拖/防缩放。
3. **脚本 `contents` 按钮同步修复**：`contentBlockRegistry.tsx` 中的 `button` 块同步保持 `block.label` 不变、仅替换图标为 `Loader2`。

### 非阻断问题

1. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`，该文件交由 CI 与容器内测试验证。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build:server`、`npm run build:mcp`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，197/197 通过。
