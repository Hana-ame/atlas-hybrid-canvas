# v30 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v30 相对 v29 的全部改动（扇出并发化、`example-spawner` 改 `emitDownstream`、Worker 池扩容），含对上游交付物自带的审查结论进行复核
> 结论：**需修改后发布**（已在本版内修复）。上游交付的 `v29-review-01.md` 结论「可发布、无阻断问题」**不成立**——它漏掉了并发化引入的三处实际缺陷。

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/App.tsx` | `emitOps` 派发与下游刷新改 `Promise.all`；新增按 `targetId + event` 归并 | 改动方向正确，但上游版本缺归并，已补 |
| `src/core/seedBlueprint.ts` | 改用 `emitDownstream` + `widgets.outputs()` 汇总 | 方向正确，但缺按控件去重，已补 |
| `src/core/scriptSandbox.ts` | `MAX_POOLED_WORKERS` 3 → 6 | 常量正确，注释未同步，已修 |
| `.github/workflows/deploy-pages.yml` | 上游交付物中该文件为旧版（无 tutorial 拷贝步骤） | 按保护清单保留仓库维护版，未覆盖 |
| `src/vite-env.d.ts` | 未改动 | 符合保护清单 |

## 审查发现

### 已确认正确

- **并发状态合并无覆盖**：各扇出分支在 `setOverlay(prev => ...)` 中函数式更新，并写入各自独立的 `runtimeVars[tid]`，`Promise.all` 并发不会互相覆盖。全部 10 处 `setOverlay` 调用均为函数式，无直接对象写入。
- **递归深度护栏保留**：`depth + 1` 与 `depth > 4` 上限在并发任务中继续生效。
- **Worker 池取用无竞态**：`idleWorkerPool.pop()` 是同步操作，JS 单线程下不会把同一个 Worker 分给两个任务；`finish()` 中先 `worker.onmessage = null` 再回池，复用安全。
- **超时路径正确**：`MAX_COMPUTE_MS = 5000`，超时走 `releasePooledWorker(worker, false)` 直接 `terminate()`，不回池，不会把卡死 Worker 复用出去。
- **安全边界未破**：新增代码（`uniqueOutputs` / `mergedEmits` / `seen` / `payloads`）不含 26 个黑名单 token；`seedBlueprint` 中仅 `body` 与按钮 `label` 出现 `Worker` 字样，不在 `script` 字段，不触发 `validateScriptSafety`。

### 非阻断问题

1. **`docs/SCRIPT_API_GUIDE.md:28` 示例过时**
   - 影响面：仅文档，不影响运行。
   - 内容：`widgets.vars(id)` 的用法示例仍写作 `widgets.vars(vars.lastChildId)`，而种子示例已不再依赖 `lastChildId` 做扇出。
   - 处理动作：**未改**。属文档措辞，`widgets.vars(id)` 本身仍可用，示例不构成错误指导。

2. **`tutorial/05-examples-and-extension.html:258` 描述过时**
   - 影响面：仅教程页，不影响运行。
   - 内容：仍写「用 `emit(vars.lastChildId, 'ping', { text })` 投递给子卡」，与 v30 改为 `emitDownstream` 后的实际行为不符。
   - 处理动作：**未改**。教程页已随 v29 上线，此处应随下次教程更新一并校正，记入本记录以便追溯。

3. **`vars.lastChildId` 成为半死变量**
   - 影响面：仅种子示例内部。
   - 内容：`seedBlueprint.ts:167` 仍写入 `vars.lastChildId`，`:107` 仍用它渲染表头「最新：xxx」，但发送消息与读变量已不再使用。属有意保留（表头仍需要「最新子控件」语义），非缺陷。
   - 处理动作：**未改**，确认保留合理。

### 阻断问题

1. **同一目标被重复投递 → 并发下丢更新**（上游版本存在，已修）
   - 位置：`src/App.tsx` 原「3) 处理跨控件 emit」循环。
   - 影响面：全量用户可见，编辑器里出现「发了一次消息，某个下游状态没更新」。
   - 成因：上游把串行的 `for ... await` 直接换成 `Promise.all`，但 `emitOps` 未去重。同一控件可能被多条 op 命中（脚本里 `emit` 两次、或 `broadcast` 与 `emitDownstream` 目标重叠、或多条边指向同一 target）。串行版本里这些是先后独立执行，每次都读到上一次的结果；并发版本里多个 Worker **同时**拿到同一份 `inputVars` 开跑，各自算出结果后由 `setOverlay` 后写者覆盖前写者——前一次的计算结果直接丢失。
   - 修复：按 `targetId + event` 归并为一次投递，多载荷合并成数组；单次触发时仍传原对象，接收方无需区分两种情况。

2. **`emitDownstream` 计数虚高 + 接收方重复触发**（上游版本存在，已修）
   - 位置：`src/core/scriptSandbox.ts` 的 `emitDownstream`。
   - 影响面：状态栏提示数字错误；下游 `on(event)` 被同一条消息触发多次，若回调里有累加（如 `vars.received++`）会翻倍。
   - 成因：`widgets.outputs()` 按**边**返回，同一出口连两条边到同一张子卡时会返回两个同 `id` 条目，`count` 与投递次数都随之翻倍。
   - 修复：投递前按 `dst.id` 去重，`count` 改为去重后的数量。

3. **`seedBlueprint` 的 `readChild` / `sendMessage` 同口径重复计数**（上游版本存在，已修）
   - 位置：`src/core/seedBlueprint.ts`。
   - 影响面：示例面板提示「已读取 N 个下游」数字偏大、同一子卡在汇总串里重复出现。
   - 修复：新增 `uniqueOutputs()` 按 `o.id` 去重，两处调用均改用它。

4. **Worker 池注释与常量不一致**（上游版本存在，已修）
   - 位置：`src/core/scriptSandbox.ts:462`。
   - 影响面：无运行时影响，但误导后续维护者按「3」估算并发能力，而实际是 6。
   - 修复：注释改为引用常量名并说明扩容理由。

## 验证记录

- **种子脚本预检**：以 Node 类型剥离加载 `createSeedBlueprint()`，对 4 个带 `script` 的节点逐一跑 26 token 黑名单 + `AsyncFunction` 编译，**4 / 4 通过，0 问题**。
- **改动范围**：`git diff` 仅 `src/App.tsx`、`src/core/scriptSandbox.ts`、`src/core/seedBlueprint.ts` 三个文件，未触及 `vite.config.ts`、`package.json`、`src/vite-env.d.ts`。
- **保护文件**：`.github/workflows/deploy-pages.yml` 上游交付物为旧版（缺 tutorial 拷贝步骤），已按 `AGENTS.md` 保护清单**保留仓库维护版**，未覆盖。
- **版本号冲突处理**：上游交付物自带 `changelog/v29.md` 与 `changelog/v29-review-01.md`，但 `v29` 编号已被 workflow 改动先行发布并推送。按「历史文件只读」规则，未覆盖已发布的 `v29.md`，本次内容记为 `v30`。该冲突需在下次交付时前置对齐版本号。
- `npm test` / `npm run typecheck` / `npm run build`：由 CI 执行，本机不跑（`AGENTS.md` 禁止本地构建）。
