# v39 代码审查 — 02

> 审查日期：2026-11-23
> 审查范围：合并 `39.zip` 后对 v39 全部改动的二次逐行复审
> 结论：**需修改**（v39 修复的 5 项阻断均有效，但引入了 1 处 `checkDag()` 邻接表清空 Bug、1 处死变量与 1 处注释失真，已转入 v40 修复）

## 改动范围核对

相对 v38 共变更 4 个代码/文档文件（`src/App.tsx`、`src/core/scriptSandbox.ts`、`tests/scriptSandbox.test.ts`、`docs/SCRIPT_API_GUIDE.md`），29 / 29 单测与 `tsc --noEmit` 均通过。

## 审查发现

### 已确认正确

- **自环入度计账正确**：`computeTopologicalOrder()` 与沙箱 `topoSort()` 对自环边均计入入度且不入邻接表，自环节点不再被 Kahn 算法抹平。
- **校验失败默认拒绝**：`validateConnectionByWidgets()` 在 `!r.ok` 时立即阻止连线并回显错误，堵住通过语法报错绕过校验的漏洞。
- **`createdEdges` 同步完整**：`op.op === 'connect'` 与 `op.op === 'remove'` 均已双向同步 `createdEdges`。
- **递归截断有用户反馈**：`depth > 4` 中止时已写入通知栏。

### 非阻断问题

**1. `scriptSandbox.ts` 残留未使用的 `selfLoops` 集合与 `id` 形参**

`checkDag()` 中 `const selfLoops = new Set()` 只写不读；`computeTopologicalOrder()` 中 `.filter(([id, deg]) => deg > 0)` 的 `id` 未使用。

- 影响面：无运行期影响，仅代码整洁度（开启 `noUnusedLocals` 会报编译错）。
- 处理：记入 v40 清理。

**2. `src/App.tsx` 断环器注释与实现不一致**

注释写「先按同一控件在同一轮里被重复触发直接掐断，再留 depth 作为最后一道保险」，实际代码仅执行 `if (depth > 4)` 截断。

- 影响面：仅误导后续维护者。
- 处理：记入 v40 修正注释与代码一致。

### 阻断问题

**1. `checkDag()` 全图分支在 `e.source` 不在 `peerMap` 时清空了已构建的 `adj[e.source]`**

`src/core/scriptSandbox.ts` 中 `checkDag()` 第一轮循环已把所有边的出边写入 `adj[e.source]`；随后的全图 Kahn 分支写成 `if (!(e.source in inDeg)) { inDeg[e.source] = 0; adj[e.source] = []; }`，当存在不在 `peerMap` 中的源节点 ID（如残留边或未同步节点）时会直接覆盖清空其已建好的邻接表，导致后续 Kahn 入度扣减遗漏。

- 影响面：脚本调用无参 `widgets.checkDag()` 且图内存在孤立/未同步源节点时触发误判。
- 处理：记入 v40 立即改为 `if (!adj[e.source]) adj[e.source] = [];`。

## 验证记录

- `npm test`：29 / 29 通过；`tsc --noEmit`：0 报错。
