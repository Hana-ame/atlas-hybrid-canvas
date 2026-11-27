# v108 代码审查 — 01

> 审查日期：2026-11-27
> 审查范围：相对 `539900b`（v107）的全部改动（三轮深挖 Review 产出）
> 结论：**可发布**（无阻断）

## 改动范围核对

| 类别 | 文件 | 核对结果 |
| --- | --- | --- |
| 工具栏防遮挡 | `src/canvas/WidgetNode.tsx` | 悬停条从 `right-6` 移至 `right-12`，为双常驻按钮留足 48px 空间，带激活高亮与 `aria-pressed` |
| 控件级独立历史 | `server/fileStore.ts`、`server/server.ts`、`src/core/roomPath.ts`、`src/App.tsx` | 服务端按 `nodeId` 连续快照比对并摘要变更字段，`GET .../history?nodeId=...` 向后兼容且端到端测通 |
| 异步函数轮询 | `src/canvas/ElyfnRunnerBlock.tsx`、`src/canvas/contentBlockRegistry.tsx`、`src/core/types.ts` | 支持 `?async=1` 与 `202` 自动轮询 `/jobs/:id`，`AbortController` + 序号守卫防卸载泄漏与并发覆盖 |

## 审查发现

### 已确认正确

1. **只传当前打开控件的历史列表**：`App.tsx` 仅向 `widgetHistoryNodeId === entity.id` 的节点传递 `widgetHistory`，避免加载某控件历史时触发其余节点 `memo` 失效重绘。
2. **并发轮询取消安全**：`ElyfnRunnerBlock` 在卸载、连续重复点击或切换控件时通过 `runAbortRef` 与 `runSeqRef` 中止旧轮询并取消等待定时器。

### 非阻断问题

1. **本地测试跳过 `pdfUnpack.test.ts`**：宿主机未预装 `poppler-utils`/`mutool`，交由 CI 运行。

### 阻断问题

无。

## 验证记录

- `npm run typecheck`、`npm run build:server`、`npm run build:mcp`、`npm run build` 均退出码 0。
- `tsx --test` 运行除 `tests/pdfUnpack.test.ts` 外的全部测试文件，203/203 通过。
