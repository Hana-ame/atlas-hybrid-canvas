# v37 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v37 相对仓库 v36 基线的全部改动（`widgets.connect()` 双端 DAG 环路校验）
> 结论：**可发布**，v30 起记录的 DAG 绕过遗留项已彻底清零，未触碰仓库 v36 其余改动，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/scriptSandbox.ts` | `widgets.connect()` 增加同步 BFS 环路拦截 | 与 `validateDagConnection()` 语义完全一致 |
| `src/App.tsx` | `op.op === 'connect'` 与 `op.create` 的 `connect` 均过 `validateDagConnection()` | 主线程兜底防绕过，且同步更新 `createdEdges` |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **双端防绕过闭环**：同一脚本内连续调用 `widgets.connect(A, B); widgets.connect(B, C); widgets.connect(C, A);` 时，Worker 内 `edgeList` 实时累积并在第 3 条直接返回 `ok: false`；主线程落盘时再次以权威 `nextEdges` 校验，彻底消除环路入口。
- **v36 基线无损保留**：基于上传的 `36.zip` 直接打 patch，完整保留仓库 v36 全部改动与历史 `changelog/v36*.md`。
- **规范合规**：严格遵循 `AGENTS.md`，未改动任何历史 `changelog/` 文件，无根目录 `CHANGELOG.md`。

### 非阻断问题

无。

### 阻断问题

无。

## 验证记录

- `npm test`：25 / 25 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-B1AQXqIF.js`（`586239` 字节）。
