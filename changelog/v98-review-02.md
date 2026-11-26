# v98 代码审查 — 02

> 审查日期：2026-11-26
> 审查范围：v98 首次推送后的 CI 失败回执，以及 `src/core/crdt.ts` 字段级合并的补充修复
> 结论：**可发布**（CI 暴露的字段覆盖缺陷已修复并补独立回归；原 `v98-review-01.md` 结论基于源码静态审查，本文件记录回执后的增量结论）

## 改动范围核对

| 项 | 结果 |
| --- | --- |
| 首次推送 | `7948ace`，CI `45817090287` / Pages `45817090377` 均 failure，失败点唯一：`tests/crdt.test.ts:157` |
| 失败断言 | `Expected '#222' but got '#111'`：`computeRecordDiff()` 抬高顶层 rev 后，未修改字段用记录级 rev 作回退戳，盖掉了远端对该字段的显式 `fieldRevs` |
| 修复文件 | `src/core/crdt.ts`（`mergeRecordFieldsLWW()` 同名分支）、`tests/v98SecurityIndependent.test.ts`（新增独立 E） |

## 审查发现

### 已确认正确

1. **失败是真实缺陷，不是测试写错**：`computeRecordDiff(before, after, 'client-a', () => 10)` 因 `title` 变更把记录 rev 抬到 11，但 `color` 未变更也没有字段戳；与远端 `color` 显式戳 `rev=10 / client-z` 合并时，旧的 `incStamp = incFallback = {11, client-a}` 判定本地胜出，导致远端的颜色编辑丢失。这正是 P2-1「顶层 rev 与字段戳同步」修复引入的边界。
2. **修法保持墓碑语义**：只在**双方同名字段都存在**时，显式字段戳优先于对方的记录级回退戳；字段缺失分支（删除墓碑）仍按记录级 rev 裁决，已有的 `tests/crdt.test.ts:76-132` 两条墓碑/并列 rev 测试口径不变。
3. **双向都成立**：本地有显式戳、远端只有更高记录 rev 时，本地字段同样保住；双方都有显式戳时仍走原来的 `beats()`，不改变确定性排序。
4. **独立 E 非恒真**：同时断言「显式 title 高 rev 生效」「显式 color 不被回退戳覆盖」「反向保住本地显式 color」「字段缺失仍删除」四条，避免为迁就单条红测而写恒真断言。

### 非阻断问题

无新增。

### 阻断问题

无（缺陷已在本次推送的修复提交中闭环）。

## 验证记录

- 失败证据：run `45817090287`，job `139899523613`，`not ok 51`，`tests/crdt.test.ts:157`，`# fail 1`。
- 修复后：`src/core/crdt.ts` 同名分支新增 `curHasStamp` / `incHasStamp` 判定；`tests/v98SecurityIndependent.test.ts` 独立测试 4 → 5 条。
- 后续 CI 回执以修复提交的 run 为准，本地不跑构建与测试。
