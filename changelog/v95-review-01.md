# v95 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：`atlas-hybrid-canvas-v95.zip` 相对 v94 的全部改动（3 处收口），及 v91 审查遗留项的闭环情况
> 结论：**可发布**（无阻断问题；`v91-review-01.md` 的 3 项阻断 + 4 项非阻断全部闭环，仅余 3 项低风险细节）

审查方式：源码逐条人工比对，不采信交付包自带结论；行为验证交由 `tests/edgePathIndependent.test.ts`（12 条独立用例）在 CI 执行，本地不跑构建与测试。

## 一、v95 改动核实

| 改动 | 位置 | 核实结果 |
| --- | --- | --- |
| 文件头注释同步为「仅 `Alt+双击` 插入控制点」 | `src/canvas/ControllableEdge.tsx:6` | 一致。注释、`routeTooltip`、`decideEdgeDoubleClickAction()` 三处口径统一，普通双击与 `Shift+双击` 均放行给标签编辑。 |
| `hasOnUpdate: Boolean(onUpdate)` | `src/canvas/ControllableEdge.tsx:107` | 多余的真值判断已消除，只读连线（无 `onUpdate`）不会误判为可插入。 |
| `insertControlPoint()` 非有限坐标守卫 | `src/core/edgePath.ts:286` | `Number.isFinite` 前置拦截 `NaN` / `±Infinity`，返回原数组副本，外部直调也不会产出非法坐标。 |
| `resolveNodePortY()` 缺省 `handleId` 对齐首端口 | `src/core/edgePath.ts:94` | `idx = 0`，双入端口时落在 33.3%，与 React Flow「无 `targetHandle` 时连接首个句柄」一致。 |

端口公式同源复核：`WidgetNode.tsx:177,189` 为 `((idx + 1) / (len + 1)) * 100%`，`resolveNodePortY()` 为 `node.y + node.height * ((idx + 1) / (len + 1))`，两者逐字等价；`WidgetNode.tsx:90-91` 的缺省端口确为 `DEFAULT_INPUT_PORTS` / `DEFAULT_OUTPUT_PORTS`，与 `resolveNodePortY()` 的缺省分支同源，全景与近景不会错位。

## 二、v91 遗留项闭环核对

| 编号 | v91 问题 | 现状 |
| --- | --- | --- |
| 阻断 1 | 右键删除控制点被 `pointerup` 复活 | **已修复**。`startDragControlPoint` 前置 `ev.button !== 0` 早退，`createControlPointDragSession` 再兜一层；右键不会创建会话，故 `pointerup` 无草稿可提交。 |
| 阻断 2 | 单击/双击无位移也提交、污染撤销栈 | **已修复**。4px 屏幕位移阈值 + `hasChanged` 判定；`App.tsx:2005-2007` 先 `sanitize` 再 `areControlPointsEqual` 比对，相等即早退，`pushHistory()` 之前不再落空提交。 |
| 阻断 3 | 卸载时未移除 `window` 监听 | **已修复**。`dragCleanupRef` + `useEffect` 卸载清理（`ControllableEdge.tsx:97-102`），`handleDeleteControlPoint` 删点前也主动 `cleanup()`；`cleanup()` 内部 `active` 标志保证幂等。 |
| 非阻断 1 | 工具 schema / 摘要未暴露 `controlPoints`、`[]` 未归一化 | **已修复**。`agentOps.ts:851` 声明 `controlPoints` 数组；`:363-370` 摘要按需回填；`connect_edge` 用 `cps.length > 0 ? cps : undefined` 归一化。 |
| 非阻断 2 | 全景 `macro` 未按控制点绘制样条 | **已修复**。`ChunkUnderlayCanvas.tsx:409-415` 复用 `computeControlPointBezierSegments()` 逐段 `bezierCurveTo`，箭头方向取自 `evalCubicBezier(seg, 0.92)`。 |
| 非阻断 3 | 双向连线起点重复绘制实心圆 | **已修复**。`ControllableEdge.tsx:192` 以 `!markerStart` 为条件。 |
| 非阻断 4 | `changelog/v91.md` 缺发布日期与验证段 | 历史文件只读，v92 起各版本已按 `AGENTS.md` 补齐「发布日期 + 验证」两段。 |

## 三、遗留低风险细节（非阻断）

1. **`computeControlPointBezierSegments()` 仍为 uniform 参数化（`(p2 - p0) / 6`）**（`src/core/edgePath.ts:168-171`）。相邻控制点间距悬殊时切线被放大：取 `(0,0) → (5,0) → (5,300)` 时，首段 `B(t)` 的 y 最低点按公式手算为 `t = 2/3`、`y ≈ -22.2`，曲线冲出控制点包围盒约 22px。v95 已删除文件头「Centripetal」表述，故现在只是纯几何行为而非注释与实现不符。若后续改 centripetal 或 chord-length 参数化，需同步调整 `tests/edgePathIndependent.test.ts` 独立⑫ 的阈值。
2. **`pushHistory()` 位于 `setBase()` 之前**（`src/App.tsx:2007`）。`setBase` 内部二次 `areControlPointsEqual` 命中时会直接返回 `prev`，此时撤销栈已多压一条无状态变更记录。并发窗口极窄（需在两次比对之间发生外部同值写入），仅记录。
3. **`ControllableEdge` 渲染期重复 `sanitizeControlPoints`**（组件内 1 次 + `buildControlPointEdgePath()` 内部 1 次）。上限 12 项、纯整数运算，实测无性能影响，仅记录以免后续误判为热点。

## 四、验证口径

- 静态：`npm run typecheck`（`tsconfig.json` 仅 include `src` / `server` / `vite.config.ts`，**不含 `tests/`**），故测试文件的类型正确性不由 typecheck 覆盖，仅由 `npm test` 的运行时断言兜底。
- 行为：`npm test` 执行 `tests/*.test.ts`，其中 `tests/edgePathIndependent.test.ts` 12 条为本项目独立编写，覆盖路径锚点链、弧长中点、ZONE F 14 个避让控制点与 4 张卡片 + 1 条横幅的矩形不相交、入参不可变、上限饱和、索引钳位、`agentOps` 端到端 sanitize，以及本轮修复的正向回归。
- 构建与部署：交由 GitHub Actions（`CI` + `Deploy to GitHub Pages`）判定，本地不执行。
