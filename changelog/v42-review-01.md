# v42 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v39-review-02 / v40 / v41 交付物（测试覆盖补齐 + `proxySecurity.ts` 密钥注入边界修复），以及本版补充修复
> 结论：**需修改后发布**（已在本版内修复）。上游 `v41-review-01.md` 判「可发布、无阻断问题」，其核心论点是「密钥注入边界严密」，但**该边界在 `upstreamBaseUrl` 配置非法时会失效**，密钥重新泄漏给白名单主机 —— 正是 v41 声称堵住的那个洞。

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `server/proxySecurity.ts` | `injectSecret` 收紧为「配了上游只认上游」 | 方向正确，**判据选错**，已修 |
| `src/core/scriptSandbox.ts` | 删死变量 `selfLoops`、清 `id` 形参、`adj[e.source]` 覆盖改条件式 | 干净 |
| `src/App.tsx` | 断环器注释与 `depth > 4` 实现对齐 | 干净 |
| `tests/chunkTileCache.test.ts`（新） | 3 条：命中、version/dirty/lod/scale 失效、LRU 淘汰与显存归零 | 断言与源码逐条核对，成立 |
| `tests/scriptTrust.test.ts`（新） | 2 条：识别统一脚本 / 按钮脚本 / `proxy_http`；纯被动节点返回空 | 断言对象与种子数据逐项核对，成立 |
| `tests/scriptSandbox.test.ts` | +3 条：真实执行 `workerBootstrap` | 抽取正则实测可命中，13742 字符，无嵌套反引号 |
| `tests/layeredStore.test.ts` | +3 条：`vars.x/y` 压 `vars.pos`、annotation 合并、孤儿补丁丢弃 | 成立 |
| `tests/proxySecurity.test.ts` | +2 条：IP 段拦截、密钥注入边界 | 成立，但**漏了配置非法的分支** |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合保护清单 |

## 审查发现

### 阻断问题

**`injectSecret` 的判据用 `upstreamHost` 而非 `upstreamBase`，配置非法时静默回落**

`src/server/proxySecurity.ts`：

```ts
const upstreamBase = (config.upstreamBaseUrl ?? '').trim().replace(/\/+$/, '');
if (upstreamBase) {
  try { upstreamHost = new URL(upstreamBase).hostname.toLowerCase(); }
  catch { upstreamHost = ''; }        // ← 解析失败退化成空串
}
// ...
const injectSecret = upstreamHost
  ? host === upstreamHost
  : allowedHosts.length > 0 && hostMatchesAllowlist(host, allowedHosts);
```

`upstreamHost === ''` 时三元条件为假，走 `allowedHosts` 分支。而 `allowedHosts` 在生产配置里通常包含演示域名 `httpbin.org`。

实测（`upstreamBaseUrl: 'not a url'`, `allowedHosts: ['httpbin.org']`）：

| 目标 | 修复前 |
| --- | --- |
| `https://httpbin.org/get` | `ok: true, injectSecret: true` ← 密钥泄漏 |

配置写错是运维高频事故（少协议头、多空格、粘贴错行）。**漏洞从「配置正确时的设计缺陷」下沉成「配置错误时的静默降级」，v41 的修复只覆盖了前者。**

修复：把判据换成 `upstreamBase` 原始字符串。`upstreamBase` 非空但 `upstreamHost` 为空时，`host === ''` 恒为假，谁都不注入。

### 非阻断问题

**1. `auditBlueprintScripts()` 被放在 `.tsx` 里，导致新增测试实际无法运行**

`tests/scriptTrust.test.ts` 从 `../src/components/ScriptTrustModal.tsx` 引入 `auditBlueprintScripts`。该文件同时顶层引入了 `lucide-react`（React 组件）与 JSX，Node 原生加载 `.tsx` 直接抛 `ERR_UNKNOWN_FILE_EXTENSION`。

本地实跑确认：该测试文件在无 `node_modules` 环境下**跑不起来**。交付物声称的「42 / 42 全绿」是在有 `node_modules`（`tsx` + React）的环境里跑的，测试本身依赖了不该依赖的组件树。

处理：把纯函数与类型拆到 `src/core/scriptAudit.ts`，`ScriptTrustModal.tsx` 保留 `export { ... } from` 与 `export type { ... } from`（`isolatedModules: true` 下必须用 `export type`），既有导入路径不变。测试改从 `core/scriptAudit` 引入，实跑 2 / 2 通过。

**2. `server/proxySecurity.ts` 函数头注释与实现不符**

原文「Authorizes server-side secret header injection (`injectSecret`) ONLY for explicitly configured `upstreamBaseUrl` or `allowedHosts` targets」——读起来仍是「上游 **或** 白名单」，与 v41 收紧后的「配了上游就只认上游」矛盾。已改写成分支说明。

## 已确认正确

- **`checkDag()` 与 `topoSort()` 对自环的处理一致**：v40 改动后，纯自环 / 自环混正常边两种输入下两者 `ok` 判定相同。
- **`adj[e.source]` 覆盖问题已解决**：`A→B`（B 不在 `peerMap`）实测 `{ ok: true, cyclePath: [] }`，首轮构建的出边未被清空。
- **`workerBootstrap` 抽取可行**：正则 `const workerBootstrap = \`([\s\S]*?)\`;\n\n  const worker = acquirePooledWorker` 实测命中，抽取内容 13742 字符，不含反引号与 `${`，`new Function` 包装不会破。
- **`ChunkTileCache` 测试断言与实现一致**：`maxTiles = 2` 时 `bake(t0) → bake(t1) → get(c0)（刷新 lastUsed）→ bake(c2)`，`t1.lastUsed` 最小被淘汰且 `canvas.width/height` 归零，与 `evictIfNeeded()` 逐行对应。
- **`scriptTrust` 测试断言与种子数据一致**：`node-world-hub` 有 `btn-inc`（script）与 `btn-proxy`（proxy_http），`btn-bg-cycle` 同为 script；`demo-flow-checklist` 确无 script 与 buttons。

## 验证记录

交付物声称 `npm test` 42 / 42、`typecheck` 0 报错、`build` 通过。本地**无法直接复现**（`node_modules` 不存在，`AGENTS.md` 禁止本地 `npm install`）。

改用 Node 原生 `--experimental-strip-types` + 临时 ESM loader（补齐项目无扩展名导入）实跑测试文件（临时文件跑完即删，无残留）：

| 文件 | 结果 |
| --- | --- |
| `scriptSandbox` + `proxySecurity` + `layeredStore` | 23 / 23 通过 |
| `chunkTileCache` | 3 / 3 通过 |
| `scriptTrust` | 2 / 2 通过（拆分前无法加载） |

用例计数核对：v39 基线 29 + v41 新增 13 = 42（与交付物声称一致）；本版 +1 → 43。

密钥注入边界单独跑 5 项（上游同源 / 白名单第三方 / 未配上游回退 / 非法上游+白名单 / 非法上游+无白名单），修复后全部符合预期。
