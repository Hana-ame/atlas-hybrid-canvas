# v101 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：相对 `2ffec8f`（v100）的全部改动
> 结论：**可发布**（无阻断）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 控件 vars 横向拖拽 | `src/canvas/WidgetNode.tsx` | 指针捕获拖滚与原生底部细滚动条点击区域不冲突，带 `nodrag nopan nowheel` 隔离画布手势 |
| 版本历史独立抽屉 | `src/components/VersionHistoryDrawer.tsx`、`src/App.tsx` | 时间线倒序展示、标注当前线上版本、历史版本采用二次确认 + 密钥校验，与检查面板互斥打开 |
| 单元测试 | `tests/uiComponents.test.ts` | 覆盖拖拽计算与 `VersionHistoryDrawer` 渲染，共 198 条测试全过 |

## 审查发现

### 已确认正确

1. **信息架构职责清晰**：发布（Save）与回溯（Version History / Rollback）彻底拆离；顶栏可直接触达版本历史，旧弹窗左下角也提供快捷切换。
2. **安全防误触与可恢复性**：当前版本不显示误回档按钮，历史版本点击「回档至此版本」需经过内联确认并校验 `X-Blueprint-Save-Key`，且独立的 `rollbackError` 状态不与保存弹窗串扰。
3. **拖动流畅不冲突**：仅在水平溢出且左键按下位于内容区（非底部 5px 原生滚动条）时启动 pointer capture，抬起/取消/丢失捕获均清理 ref 与样式状态。

### 非阻断问题

1. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`，该文件交由 CI 与容器内测试验证。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build:server`、`npm run build:mcp`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，198/198 通过。
