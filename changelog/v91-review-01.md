# v91 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：v91（提交 `1e63ff3`）相对 v90（`81fbfd8`）的全部改动，9 个文件 +623 / −2
> 结论：**可发布**（无阻断项；2 项 P1 与 3 项 P2 非阻断缺陷建议 v92 收敛，其中 P1-2 需真机确认）

本次为**独立审查**：不复用 `tests/edgePath.test.ts` 的断言口径，改为解析 SVG path 指令、按种子数据真实几何做断言；配套新增 `tests/edgePathIndependent.test.ts`（12 条用例）。

## 改动范围核对

| 项 | 结果 |
| --- | --- |
| 交付物与 HEAD 逐文件比对 | 差异恰为 9 个文件，与 `v91.md` 声明一一对应，无夹带改动 |
| 受保护的仓库维护版文件 | `.github/workflows/deploy-pages.yml`、`src/vite-env.d.ts` 未被覆盖 |
| 数据模型 | `types.ts:239` 新增 `EdgeControlPoint`，`types.ts:256` `BlueprintEdge.controlPoints?`，无版本号变更（向后兼容：旧数据无该字段即视为无控制点） |
| 数据流贯通 | `agentOps.connect_edge`（写入前 sanitize）→ `seedBlueprint`（5 条预置走线）→ `App.handleUpdateEdgeControlPoints`（rev+1 / cid=SELF_CID）→ `ControllableEdge` → `edgePath` 全链路无断点 |
| 协同链路 | `crdt.ts` 为字段级 LWW，`roomServer` 对 `edges` 集合做泛型 upsert，**均无字段白名单**，故 `controlPoints` 能随 edges 正常同步；`computeRecordDiff` 会为其单独生成 `fieldRevs`，并发拖点与改标签可分别裁决 |
| 端口方向 | 全仓库 Handle 仅 `Position.Left` / `Position.Right`（`WidgetNode.tsx:184,196`），水平贝塞尔与端口方向一致 |

## 审查发现

### 已确认正确

1. **样条严格穿过每个控制点**：`M` 起点 + 每段 `C` 的终点序列 == `[source, ...controlPoints, target]`，段数恒为 `控制点数 + 1`，无跳点、无多画少画（`独立①⑨` 解析 path 指令验证）。
2. **无控制点时的退化路径**：单段三次贝塞尔，控制柄水平偏移 `max(48, 0.45·|Δx|)`，标签取解析式 `0.125P0+0.375C1+0.375C2+0.125P3`（即 t=0.5 贝塞尔点），必落在端点包围盒内（`独立②`）。
3. **标签定位**：落在**控制多边形**弧长 50% 处（`edgePath.ts:96` 注释即写「折线弧长」，实现与注释一致），对零长段有 `segLengths[i] > 0` 除零保护。
4. **上限 12 的饱和行为**：超限按前 N 个截断；满额后 `insertControlPoint` 长度与内容均不变；`sanitize` 对自身输出幂等（`独立④⑤`）。
5. **不可变性**：`insertControlPoint` / `removeControlPoint` 均不修改入参数组并返回新数组；`applyAgentOperations` 通过 `normalizeAgentBlueprint` 做 JSON 深拷贝，不污染调用方蓝图（`独立⑤⑧`）。
6. **索引语义正确**：`findBestInsertIndex` 返回的是「插入到第几段之前」，与 `insertControlPoint` 的 splice 索引一致；含 t 钳位、零长段 `lenSq <= 1e-4` 兜底，退化输入不抛异常（`独立⑥`）。
7. **ZONE F 真实避让成立**：五条回退连线共 14 个控制点，**全部落在四张状态卡矩形之外**；14 点互不重合；`cancel` 全部位于卡片上沿 y=2040 之上；`pause`（x=890）与 `resume`（x=878）两条垂直走廊不共线（`独立⑦`）。原测试仅断言 `length >= 2`，未覆盖该结论。
8. **渲染健壮性**：起点锚点 `pointerEvents="none"` 不挡命中；透明热区 18px；拖动用 window `pointermove/pointerup/pointercancel` + 卸载清理，快速拖动不脱手；满额时「+」手柄不渲染（`ControllableEdge.tsx:202,204,227`）。

### 非阻断问题

**P1-1 单击控制点即产生一次提交（无位移也落盘）**
`ControllableEdge.tsx:84-93` 的 `handleUp` 无条件调用 `onUpdate(id, finalPoints)`，未与初始值比较。后果：单击（只为选中/查看）也会触发 `pushHistory()`、`rev+1`、`cid=SELF_CID`，即**一次撤销栈条目 + 一次协同广播**，而数据实际未变。左键双击控制点时该路径会先提交两次再删除，撤销需连按三次才能回到删除前。
影响面：全部用户，纯交互层，不损坏数据。处理动作：**记入已知遗留**，建议 v92 在 `handleUp` 内比较起点与终点坐标，无变化则不调用 `onUpdate`。

**P1-2 右键删除控制点在 macOS/Linux 可能被 pointerup 复活**
`onContextMenu`（`:204`）走 `handleDeleteControlPoint`，而同一元素上的 `onPointerDown`（`:202`）已启动拖动并写入 `draftRef`。若浏览器在 pointerdown 之后、pointerup 之前派发 contextmenu（macOS/Linux 的惯例），则执行顺序为：指针按下 → 删除（提交 N−1 个点）→ 指针抬起 → `handleUp` 用 `draftRef`（仍是 N 个点）再次提交，被删点**当场复活**；期间 `draftPoints !== null` 会让已删除的手柄继续渲染。Windows 在 mouseup 后派发 contextmenu，顺序相反，不受影响。
影响面：macOS/Linux 用户使用右键删除时；**本次未实机验证**（无浏览器环境），属代码路径推演。处理动作：**记入已知遗留**，建议修法为 `handleDeleteControlPoint` 同时清空 `draftRef`/`draftPoints`，或 pointerdown 仅接受主键（`ev.button !== 0` 直接 return）。若真机确认，应升级为阻断。

**P2-1 `sanitizeControlPoints` 把 `null` / 空串 / 空数组 / 布尔强转为 0**
`edgePath.ts:19` 用 `Number(item.x)` 取值：`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`、`Number(true) === 1`，于是 `{x: null, y: 3}` 被静默落成原点控制点 `(0,3)`，而不是丢弃。只有 `undefined`、`NaN`、`Infinity` 会被正确拒绝。
影响面：仅影响 `controlPoints` 携带脏数据的来源（外部 Agent 批量下发、手改 JSON、跨版本导入），UI 拖拽不会产生此类值。处理动作：**记入已知遗留**，建议改为 `typeof x === 'number' && Number.isFinite(x)`；`独立⑩` 已锁定当前行为，修复时该用例会失败并提示同步更新。

**P2-2 「+」手柄与段中点取的是弦中点，不在渲染曲线上**
`edgePath.ts:89` 用相邻两点的算术平均作为段中点。曲线经 Catmull-Rom 后在弦外鼓出，手柄会明显脱离线条：实测 `source(0,0) → cp(0,200) → target(300,200)` 时，弦中点 `(0,100)` 与曲线 t=0.5 点 `(-18.75,100)` 相距 **18.75px**。点击该「+」插入的控制点落在弦中点，曲线会随之跳动。对比：无控制点分支的手柄取的正是曲线上 t=0.5 点，两条分支口径不一致。
影响面：所有带控制点的连线，悬停/选中时可见。处理动作：**记入已知遗留**，建议按对应三次贝塞尔的 t=0.5 点（或按真实弧长采样）计算手柄位置。`独立⑪` 已锁定。

**P2-3 uniform Catmull-Rom 在疏密不均时冲出包围盒，与注释「Centripetal/Uniform」不符**
`edgePath.ts:70-71` 的 `/6` 是 **uniform** 参数化，文件头注释却写「Centripetal/Uniform」。uniform 在相邻间距悬殊时切线被放大：`source(0,0) → cp(5,0) → target(5,300)`（5px 与 300px）时曲线向上过冲到 **y ≈ −22.2**，远超控制点包围盒上界 y=0。用户在画布上随手拖点极易造出这种疏密组合，表现为线条打圈/自交。
影响面：带控制点连线的可视形状，全量用户；不崩溃、不损数据。处理动作：**记入已知遗留**，建议按 centripetal（α=0.5）参数化重算切线，与注释对齐。`独立⑫` 已锁定。

**P3-1 全局连线曲率变化未在版本文件中记录**
v91 前所有连线走 React Flow 默认贝塞尔（曲率 0.25），v91 后统一换成 `ControllableEdge`，无控制点分支用 `max(48, 0.45·|Δx|)`（`edgePath.ts:40`），且 `strokeWidth` 由 2 改为 2.2（`App.tsx`）。即**所有既有图（含非 ZONE F 的连线）形状都变了**，而 `v91.md` 只描述了新交互，未提及这处全量视觉变更。
影响面：全部用户、全部既有连线。处理动作：**记入已知遗留**（不阻塞发布，但应在 v92 的 `v92.md` 中如实登记，避免读者误以为是渲染回归）。

**P3-2 自定义边忽略 `sourcePosition` / `targetPosition`**
`ControllableEdge.tsx` 只解构 `sourceX/Y、targetX/Y`，未读取端口方向。当前全仓库端口只有 Left/Right，水平贝塞尔正确；一旦将来加入 Top/Bottom 端口，连线会按水平方向出线，出现倒钩。处理动作：**记入已知遗留**（结构性限制，非当前缺陷）。

**P3-3 满额 12 时双击连线仍会提交一次空变更**
`ControllableEdge.tsx:125` 在 `insertControlPoint` 返回原数组（已满额）时仍调用 `onUpdate`，同样产生空撤销条目与广播。与 P1-1 同源，可一并修复。处理动作：**记入已知遗留**。

**P3-4 `committedPoints` 每次渲染重建，`memo` 失效**
`ControllableEdge.tsx:46` 每次 render 调用 `sanitizeControlPoints` 生成新数组，作为 `useCallback` 依赖导致 `handleEdgeDoubleClick` / `handleDeleteControlPoint` 每次渲染都变；`React.memo` 因 `data` 对象在 `App` 中每次重建而失效。表现为连线较多时的无谓重算（`buildControlPointEdgePath` 每帧对每条边执行）。处理动作：**记入已知遗留**，建议 `useMemo` 包裹。

### 阻断问题

无。

## 验证记录

- **本地未执行任何命令**（按项目要求，本地验证已禁止），全部结论以 **CI** 为准。
- 新增独立测试：`tests/edgePathIndependent.test.ts`，共 **12** 条 —— 9 条不变量/边界用例（独立①~⑨）+ 3 条现状锁定用例（独立⑩~⑫）。
  - 独立①：解析 path 指令，断言锚点链 == `[source, ...cps, target]`、段数 == cps+1；
  - 独立⑦：按种子实际矩形做几何避让断言（控制点不得落入卡片内部）、14 点唯一性、cancel 顶部走廊、pause/resume 走廊不共线；
  - 独立⑧：`connect_edge` 端到端，NaN 控制点被丢弃、`{100.4, 200.6}` → `{100, 201}`、入参蓝图不被修改；
  - 独立⑩⑪⑫：把 P2-1 / P2-2 / P2-3 的当前数值钉住（`{x:null}`→`(0,3)`、弦中点偏离 18.75px、过冲 y≈−22.2），修复后这些断言会失败，强制同步更新本文档。
- 关键数字均为手算复核：贝塞尔 t=0.5 点 `0.125P0+0.375C1+0.375C2+0.125P3`；控制柄 `P1+(P2−P0)/6`；ZONE F 卡片矩形 IDLE `560,2040 280×195`、RUNNING `920,2040 310×205`、PAUSED `920,2295 310×195`、DONE `1310,2040 290×195`。
- CI 基线：v91 代码提交 `1e63ff3` 的 `CI`（run `45629956788`）与 `Deploy to GitHub Pages`（run `45629956663`）均为 success，含 Typecheck / Build server / Unit & roomServer tests / Build frontend 全步骤；本审查新增的测试纳入同一条 `npm test` 通道，随本次提交的 CI run 一起校验（审查文件按约定只读，不再回填后续 run 号）。
