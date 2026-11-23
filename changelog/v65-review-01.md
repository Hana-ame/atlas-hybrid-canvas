# v65 代码审查记录（Review 01）

## 审查范围
本次逐行审查 v63–v65 新增的媒体与交互控件代码及默认蓝图示例：
- `src/core/mediaHelper.ts`
- `src/canvas/ImageNodeBlock.tsx`
- `src/canvas/VideoNodeBlock.tsx`
- `src/canvas/SliderControlBlock.tsx`
- `src/canvas/Pad2DControlBlock.tsx`
- `src/canvas/ImageButtonBlock.tsx`
- `src/core/seedBlueprint.ts`、`src/canvas/WidgetNode.tsx`、`src/App.tsx`

## 发现与处置

| 级别 | 位置 | 问题描述 | 处置状态 |
| :--- | :--- | :--- | :--- |
| P2 | `src/canvas/ImageNodeBlock.tsx` | 大图灯箱使用 `fixed inset-0` 直接挂在 React Flow 节点内部；由于 `.react-flow__viewport` 带有 CSS `transform`，`fixed` 会退化为相对视口变换层定位并被裁切，且缺少 `Esc` 关闭 | 已修复：改用 `createPortal(..., document.body)` 真正全屏挂载，并补齐 `Escape` 监听 |
| P2 | `src/canvas/Pad2DControlBlock.tsx` | X/Y 数值框直接绑定 `safeX/safeY` 并在 `onChange` 立即 `clampSliderValue`，清空或输入负号 `"-"` 时会被瞬间弹回 `0`，导致无法手打负数坐标 | 已修复：引入 `xDraft`/`yDraft` 本地草稿态与 `inputMode="decimal"`，合法数字即时更新、失焦/回车统一归一化提交 |
| P3 | `src/canvas/SliderControlBlock.tsx` | 滑块仅在 `onPointerUp`/`onKeyUp` 触发 `onCommit`，移动端或浏览器触发 `pointercancel` 时会漏掉脚本与下游联动提交 | 已修复：补齐 `onPointerCancel` 提交回调 |

## 复核结论
- 3 项发现均已修复并通过 `tsc --noEmit`、`vite build` 及 85/85 单元测试（含 `seedBlueprint.test.ts` 零重叠与脚本安全编译检查），无阻断级或高危遗留问题。
