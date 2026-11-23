# v23 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：`atlas-hybrid-canvas-v23.zip` 相对 `HEAD`（v21）的全部改动
> 结论：**可发布**，存在 3 项已知遗留，无阻断问题

## 改动范围核对

与 `HEAD` 逐文件哈希比对：SAME 44 / DIFF 10 / NEW 1 / GONE 0，符合预期。

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/layeredStore.ts` | 5903 → 7995 | `vars` 控形核心，逐行核对 |
| `src/core/seedBlueprint.ts` | 17196 → 19872 | ZONE D 演示卡扩充 |
| `src/core/widgetTemplates.ts` | 13182 → 15856 | 新增 `tpl-var-morph` |
| `src/App.tsx` | 69316 → 69433 | 仅 1 处布局变量检测 |
| `src/canvas/WidgetNode.tsx` | 20860 → 20943 | 变量面板过滤收敛 |
| `tests/layeredStore.test.ts` | 新增 1501 | 2 条用例 |
| `src/vite-env.d.ts` | 441 → 311 | 交付物回退，已保留仓库维护版 |

## 审查发现

### 已确认正确

- **钳位双向生效**：`width` 钳到 `180–1400`、`height` 钳到 `100–1200`，且先 `Math.round` 再钳位，不会出现小数尺寸。边界用例（`width: 50` → 180、`height: 99999` → 1200）覆盖到位。
- **`vars.type` 映射**：`vars.type` 与别名 `vars.category` 落到 `out.category`，先判 `type` 再回退 `category`，与测试断言 `resolved.category === 'ALERT'` 一致。
- **DAG 环路检测**：`validateDagConnection` 用 BFS 从 `target` 出发找能否回到 `source`，方向正确，自环单独短路。
- **Worker 池无状态污染**：`workerBootstrap` 是固定字符串（不含脚本内容，`code` 走 `postMessage`），且 `logs` / `annotationOps` / `vars` / `handlers` 全部在 `onmessage` 内 `const` 重新声明，复用安全。
- **密钥比较**：`verifySaveKey` / `verifyProxyClientToken` 均先比长度再 `crypto.timingSafeEqual`，无时序泄漏。
- **模板脚本安全性**：11 段内置模板脚本对 26 个沙箱黑名单 token 命中 0。

### 非阻断问题

**1. `vars.pos` 与 `vars.x` / `vars.y` 隐性覆盖**

`extractVarDrivenProps()` 中 `vars.pos` 先写入 `out.x` / `out.y`，随后 `vars.x` / `vars.y` 覆盖前者。语义合理（显式坐标更具体），但文档未说明，易让脚本作者困惑。

- 处理：不改代码，在 `v23.md` 的「说明」段落记录优先级。

**2. `proxyRateHits` 无过期清理（v21 遗留）**

`server/server.ts` 的限流 Map 每个新 IP 新建数组且永不删除 key，长期运行内存缓慢增长。

- 影响面：仅自托管 server，不影响 Pages 静态部署。
- 处理：本版不修，记入已知遗留。

**3. `useOverlaySync` 的防回环标记是单次消费（v21 遗留，当前未接线）**

`skipNextSaveRef` 只消费一次；若多条远端消息合并进同一渲染批次，第二条会被再次广播，形成 `A→B→A` 抖动。`subscribeCrossTabOverlay` 仅按 `tabId` 排除自己，无内容比对。

- 影响面：仅在 hook 真正接线后、且多标签页同时编辑时触发。
- 处理：本版不修（hooks 未接线，问题不显现），记入已知遗留。

### 阻断问题

无。

## 验证记录

- 15 条自动化用例全部通过。
- CI（`e26c483` 前一次 `091831f`）：`typecheck` + `build` + Pages deploy 均 success。
- 线上产物：`index-DvnreBWS.js` 565240 字节，`tpl-var-morph` / `vars 控形示例` / `vars 驱动形态` 均在，既有标记（`x-blueprint-save-key`、`BroadcastChannel`、DAG 与超时文案）无回退。
