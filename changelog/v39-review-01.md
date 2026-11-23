# v39 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：合并 v37 / v38 交付物（连线校验权下放至控件脚本）后的全量核对，以及本版补充的修复
> 结论：**需修改后发布**（已在本版内修复）。上游 `v38-review-01.md` 判「可发布、无阻断问题、27/27 全绿」，实际存在 **5 处缺陷**，其中 3 处直接破坏本版主功能（`checkDag()` 在自环存在时对所有连线误报、校验脚本报错被静默当成放行、子控件新建边不进快照）。

## 交付物比对

相对 v36，共 9 个文件有差异，无文件丢失：

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `AGENTS.md` | 第 137 行：连线约束从「必须过 `validateDagConnection()`」改为「默认自由拓扑，由 `onValidateConnect()` + `widgets.checkDag()` 自主声明」 | **有意修改**，与代码同步，规则自洽，予以接受 |
| `src/core/scriptSandbox.ts` | 新增 `computeTopologicalOrder()` / `checkDag` / `topoSort` / `onValidateConnect` / `ConnectValidationPayload`；`validateDagConnection()` 增加 `cyclePath`；`connect()` 移除硬编码禁环 | 4 处缺陷，已修 |
| `src/App.tsx` | 新增 `validateConnectionByWidgets()`，`onConnect` 改异步；`op:'connect'` 写入 `createdEdges` | 2 处缺陷，已修 |
| `src/core/seedBlueprint.ts` | 「③ 连线数据汇总」示例新增 `onValidateConnect` | 干净 |
| `tests/scriptSandbox.test.ts` | 新增 `cyclePath` 与 `computeTopologicalOrder` 两条单测 | 未覆盖自环与「既存环」，已补 2 条 |
| `changelog/v37.md` / `v37-review-01.md` / `v38.md` / `v38-review-01.md` | 交付物自带 | 新增，符合「一版一文件」 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合保护清单 |

### 既有修复未被回退

逐项 `grep` 计数比对（v36 工作区 vs v38 交付物），全部一致：

`mergedEmits` 8/8、`uniqueOutputs` 3/3、`emitDownstream` 去重 5/5、`MAX_POOLED_WORKERS` 3/3、`PDF_UPLOAD_MAX_BYTES` 5/5、`express.raw` 4/4、`uploadedPdfStore.delete`（真 LRU）2/2、`entity.too.large` 1/1、annotation 签名 `slice(-16)` 1/1、`idleHandle !== null) return` 1/1、分块签名 `N:${n.id}` 1/1。

## 审查发现

### 阻断问题

#### 1. `widgets.checkDag()` / `topoSort()` 自环被 Kahn 抹平

**位置**：`src/core/scriptSandbox.ts` 沙箱内 `checkDag` 全图分支、`topoSort`；同名逻辑在 `computeTopologicalOrder()`。

原实现只按 `edgeList` 累加 `inDeg[e.target]`，`adj` 里却**不预置** `adj[e.target]`。以 `A → A` 自环为例：`inDeg.A = 1`，但 `adj.A` 不存在，`A` 永远不会被出队，`inDeg.A` 恒为 1 —— 结果「碰巧」是对的。可只要再接一条正常边 `A → B`：`B` 的入度也永远减不下来，`B` 被误判成环内节点。

更严重的是 `topoSort` 里那句 `if (e.source === e.target) continue;` —— 直接把自环边丢掉，`inDeg.A` 停在 0，`A` 被当成正常源点出队，**环被彻底抹平**，返回 `ok: true`。

**影响**：`topoSort` 是给控件脚本用的公开 API。用户脚本若按它决定执行顺序，自环会被静默忽略。

**修复**：自环边**计入入度**（保证不被当源点出队），但**不进邻接表**（保证出队时不会把自身入度减回 0）。三处（`checkDag` 全图、`topoSort`、`computeTopologicalOrder`）统一。

#### 2. `validateConnectionByWidgets()` 把「校验脚本跑挂了」当成放行

**位置**：`src/App.tsx` 的 `validateConnectionByWidgets()`。

原实现只检查 `r.ok && r.connectValidation && !r.connectValidation.ok`，脚本执行失败（`r.ok === false`，语法错误 / 5000ms 超时 / 抛异常）时既不判拒绝也不报错，直接落到 `return { ok: true }`。

**影响**：给校验脚本写个语法错误，就能让本该禁环的控件静默放行 —— 安全护栏可被一行 typo 绕过。

**修复**：`!r.ok` 一律按拒绝处理，状态栏给出「连线校验脚本执行失败，已阻止连线：<原因>」。

#### 3. 子控件脚本 `widgets.connect()` 新建的边不进本批快照

**位置**：`src/App.tsx` 的 `setBase` 内 `op.op === 'connect'` 分支。

`op.op === 'create'` 分支把新建边同时写进 `nextEdges` 与 `createdEdges`，`op.op === 'connect'` 分支只写了 `nextEdges`。而 `createdEdges` 正是传给同批子控件 `render` 的连线快照。

**影响**：一个脚本里先 `widgets.connect()` 建边、再新建带脚本的子控件时，子控件 `render` 里的 `widgets.checkDag()` / `topoSort()` / `widgets.inputs()` 全都看不到这条边 —— DAG 判断与执行顺序失真。`op.op === 'remove'` 也只从 `nextEdges` 删，`createdEdges` 残留已删边。

**修复**：`connect` 分支同步写 `createdEdges`；`remove` 分支同步清理 `createdEdges`。

#### 4. `checkDag(fromId, toId)` 方向反了，把既有环算到新连线头上

**位置**：`src/core/scriptSandbox.ts` 沙箱内 `checkDag` 的双参分支。

本版设计是「画布本就允许存在环」。那么判断「新增 `f→t` 是否成环」的唯一正确判据是：**从 `t` 出发能否沿现有边走回 `f`**。原实现写成了「从 `f` 出发能否回到 `f`」—— 只要 `f` 自身在一个既有环里，**任意** `f→x` 都会被判成环。

**验证**：`A→B, B→A` 既存，调 `checkDag('A','C')`，原实现返回 `ok: false`，但实际上 `A→C` 显然不成环。

**修复**：改回从 `t` 出发、判断能否抵达 `f`；路径拼接也一并修正（原文先 `[f,t]` 再 `reverse()`，会把整条路径倒序）。

#### 5. 递归截断无任何反馈

**位置**：`src/App.tsx` `executeUnifiedWidgetScript` 的 `if (depth > 4) return;`。

v38 移除了全局 DAG 拦截后，环路不再被拦在建边环节，唯一的运行时兜底就是这个深度上限。但它静默返回，用户只看到「消息发了但没反应」。

**修复**：超出时写状态栏「事件链已连续传导 5 层，为避免环路无限递归已中止（最后一次触发：<控件名>）」，并加注释说明为何只靠 depth 不够（每层 emit 都起 Worker，最坏 5 层扇出会把池和 CPU 打满）。

### 非阻断问题

- `AGENTS.md` 第 137 行同时是唯一提到 `onValidateConnect()` / `widgets.checkDag()` 的地方，`docs/SCRIPT_API_GUIDE.md` 完全没提这两个新 API 与「默认允许自由拓扑」的语义变更 —— 已补「自主声明连线约束」章节、三条 API 表项，并把第四节「跨控件消息防环保护」的表述改准。
- `validateDagConnection()` 在 v37 被下游当作「连线前校验」的公开发布函数。本版把决策权下放后它仍被 `validateConnectionByWidgets()` 用作**信息提供**（算 `wouldCycle` / `cyclePath`），职责已从「拦截」降为「算信息」，但 `reason` 文案仍是「已自动拦截」，有误导 —— 未改动，理由：该文案仍是 `handleRunButton` 等旧路径的用户可见提示，改词会牵连 UI 文案一致性，留待专门一轮处理。

### 上游审查结论的偏差

`v38-review-01.md` 的核心论点「安全护栏（递归深度 + 超时 + 未信任脚本隔离）完好，无阻断问题」不成立：

- 「递归深度完好」——深度上限确实还在，但它**没有提示**，且本版已无其他运行时防环手段；上游把「还有 depth」直接等同于「护栏完好」。
- 「未信任脚本隔离」——隔离本身没问题，但**校验失败被当成放行**（发现 2），这恰恰是隔离链上最该堵的缺口。
- 「27 / 27 全绿」——测试确实没红，但两条新测只覆盖了 `C→A` 单向成环与标准 DAG，**自环**和**既存环下连无关边**这两个本版最容易踩的边界一个都没测。

## 本版补充测试

`tests/scriptSandbox.test.ts` 新增 2 条：

- `computeTopologicalOrder() detects self-loops instead of silently dropping them` —— 纯自环 + 自环混正常边。
- `validateDagConnection() ignores pre-existing cycles that are unrelated to the new edge` —— 既存自环 / 既存环都不阻塞无关连线，但真成环的连线仍必须拦下。

## 验证记录

交付物声称 `npm test` 27/27、`npm run typecheck` 0 报错、`npm run build` 通过。本地**无法复现**这三项：`node_modules` 不存在，`AGENTS.md` 禁止本地 `npm install`。

改用一次性断言脚本（跑完即删，未留任何文件）验证纯函数逻辑：

- `validateDagConnection` / `computeTopologicalOrder`：11 项断言全通过，含既存自环、既存环、长链成环路径、自环不被抹平。
- 沙箱内 `checkDag` / `topoSort`（从源码抽取函数体、在 Node 里重建 `peerMap` / `edgeList` 上下文执行）：14 项断言全通过，含双参分支方向、既存环不污染、自环检出、孤立节点不入环。
- `src/core/scriptSandbox.ts` 模块加载：`--experimental-strip-types` 导入成功，导出符号齐备，无残留变量。
