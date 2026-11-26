# v97 代码审查 — 01

> 审查日期：2026-11-26
> 审查范围：`atlas-hybrid-canvas-fixed (1).zip` 中 `src/core/edgePath.ts` 与 `tests/edgePathIndependent.test.ts` 两处改动，及与 v96 本地改动的合并结果
> 结论：**可发布**（无阻断；1 项非阻断，属于极微小退化阈值细节）

审查方式：逐行对比 zip 与 HEAD，按 Centripetal Catmull-Rom 公式手算两组关键几何；不采信交付包自带结论，本地不跑构建与测试。

## 改动范围核对

| 项 | 结果 |
| --- | --- |
| zip 相对 HEAD 的差异 | 仅 `src/core/edgePath.ts`、`tests/edgePathIndependent.test.ts`；另有 README 为旧版 v12、缺 v96 两份 changelog 与 `tests/inlineLabelIndependent.test.ts` |
| 合并策略 | 只取上述两处；README（v96 内容）、`changelog/v96*.md`、`tests/inlineLabelIndependent.test.ts` 全部保留，README 版本推进 v97 |
| 是否回退 v96 功能 | 否。`App.tsx` / `ControllableEdge.tsx` / `index.css` / `uiComponents.test.ts` 与 HEAD 逐字节一致 |

## 审查发现

### 已确认正确

1. **参数化公式正确**：`knotStep = sqrt(hypot(Δx, Δy))` 即 `|Δ|^0.5`，符合 α = 0.5 的 centripetal 定义；控制柄使用 `d1²·(p2-p1) + d2²·(p1-p0)` 除以 `3·d1·(d1+d2)`，与标准 Catmull-Rom→Bezier 转换式一致。
2. **端点处理合理**：首段以 `p0 = 2p1 - p2` 补ghost点（此时 `d1 = d2`），末段以 `p3 = 2p2 - p1` 补点（`d3 = d2`），端点切线不会因缺邻点而塌成折线。
3. **退化分支齐全**：`d2 < 1e-6` 直接取 `cp1 = p1`、`cp2 = p2`，重合点段落为直线；`d1` / `d3` 近零分别退回 `/3` 等分；不会有除零或 `NaN` 坐标。
4. **过冲收敛可手算复现**：`(0,0) → (5,0) → (5,300)` 首段 `d1=d2=√5`、`d3=√300`，算得 `cp2y = -1500/(3·√300·(√300+√5)) ≈ -1.48`，三次曲线最低点 `y ≈ -0.66`，满足独立⑫ 的 `minY >= -2`；uniform 时期该值约 `-22.2`。
5. **独立⑪ 仍非恒真**：新几何下 `(0,0)→(0,200)→(300,200)` 首段 `B(0.5) ≈ (-13.76, 111.25)`，与弦中点 `(0,100)` 相距约 `17.8px > 15px` 的阈值，同时「+」手柄取同一 `B(0.5)` 并取整，偏差约 `0.35px <= 2px`，正反断言都成立。
6. **对外契约未变**：C 指令端点序列仍是 `[起点, ...控制点, 终点]`，无控制点分支仍用 `dx = max(48, |Δx|·0.45)` 的独立公式；`labelX/labelY` 与 `segmentMidpoints` 仍取 `evalCubicBezier`，全景 Canvas 共用 `computeControlPointBezierSegments()`，不会出现近景/全景走线分叉。
7. **其它测试无硬编码旧控制柄坐标**：`tests/edgePath.test.ts` 等文件未断言 `cp1x/cp1y/cp2x/cp2y` 的具体数值，几何升级不会造成与断言口径的冲突。
8. **v96 独立测试不受影响**：`tests/inlineLabelIndependent.test.ts` 的避让用例走无控制点分支，其余 pointer-events / 源码级断言与控制柄公式无关。

### 非阻断问题

1. **退化阈值单位与直觉不同**（`src/core/edgePath.ts:158-161`）：`EPS = 1e-6` 比较的是 knot step（`sqrt(距离)`），对应原始距离约 `1e-12`；距离 `1e-8` 级别的近重合点不会触发直线退化，控制柄会很大但仍为有限数，不会产出 `NaN`。影响面：仅几何坐标几乎完全重合的人造数据；实际画布坐标为取整后的整数，无法触发。处理动作：**未改，非阻断**。

### 阻断问题

无。

## 验证记录

- 独立测试：`tests/edgePathIndependent.test.ts` 12 条（⑫ 已改为正向回归），`tests/inlineLabelIndependent.test.ts` 5 条，`tests/` 共 184 条 `test()` 声明（源码计数）。
- 手算证据：`(0,0)→(5,0)→(5,300)` 的 `minY ≈ -0.66`（阈值 -2）；`(0,0)→(0,200)→(300,200)` 的 `B(0.5) ≈ (-13.76, 111.25)`（非恒真阈值 15）。
- `npm run typecheck` 不含 `tests/`，测试文件正确性由 `npm test` 运行时断言覆盖。
- CI / Pages：本地不执行，推送后以 GitHub Actions run、部署产物 hash 与 HTTP 200 为准。
