# v24 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v24 相对 v23 的全部改动
> 结论：**可发布**，v23-review-01 与 v23-review-02 中的全部已知问题均已闭环，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/layeredStore.ts` | 新增 `clearConflictingRuntimeVars()` | 纯函数，仅清理与手动 patch 冲突的键 |
| `src/hooks/useOverlaySync.ts` | 单次标记改为内容指纹比对 | 根治多消息合批回环 |
| `src/hooks/useBlueprintHistory.ts` | 改为 ref 稳定回调 + 50 步上限 | 与 `App.tsx` 状态契约对齐 |
| `src/App.tsx` | 接通双 Hook、删除冗余内联栈、拖拽/编辑清理冲突变量 | 逻辑更瘦、无未用 import |
| `server/server.ts` | `proxyRateHits` 增加 5 分钟 / 200 条目过期回收 | 消除自托管长跑内存泄漏 |
| `tests/layeredStore.test.ts` | 新增 2 条冲突清理回归用例 | 共 17 条全绿 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 严格遵循 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **手动操作不再弹回**：`handlePatchNode` 覆盖缩放、标题、分类、配色、锁定，`onNodesChange` 覆盖拖拽松手坐标；两者均通过 `clearConflictingRuntimeVars()` 精准移除 `runtimeVars` 冲突键，且单测证实业务变量（如 `score`）不受影响。
- **双 Hook 真实生效且无回环**：`App.tsx` 不再存在内联 `historyPastRef` 或裸 `saveLocalOverlay` 调用；`useOverlaySync` 以 `JSON.stringify` 指纹去重，连续收到多条跨页签消息不会触发回写广播。
- **限流器内存有界**：滑动窗口 `60s` 外的 IP 会在 `300s` 间隔或 `size > 200` 时自动回收，原有 `30 次/分钟` 限流阈值与 `429 Retry-After` 行为不变。
- **历史只读与命名规范**：未修改任何既有 `changelog/` 文件，无根目录 `CHANGELOG.md`。

### 非阻断问题

**1. `useOverlaySync` 内容指纹采用全量 `JSON.stringify(overlay)`**

当单个节点在 `overlay` 中挂载超大 base64 数据时，每次防抖比对会序列化一次叠加层；当前背景图已自动压缩且存于 `base.annotations`，`overlay` 仅含轻量变量与补丁，开销可忽略。

- 影响面：仅极端大 `runtimeVars` 场景。
- 处理：暂不优化，保持实现简洁。

### 阻断问题

无。

## 验证记录

- `npm test`：17 / 17 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-DwSgREFm.js`（`567165` 字节）。
