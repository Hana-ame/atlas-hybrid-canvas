# AGENTS.md

面向在本仓库工作的 AI agent / 协作者的约定。**动手前先读完本文件。**

---

## Changelog 规则（必读）

本项目的变更日志采用 **一版一文件、只增不删** 的归档方式。任何改动发布时都必须遵守以下规则。

### 目录与命名

| 项 | 规定 |
| --- | --- |
| 唯一位置 | `changelog/` 目录 |
| 文件名 | 版本号 + `.md`，如 `v23.md`、`v24.md` |
| 合并版本 | 相邻多个版本一次发布时用区间，如 `v19-v20.md` |
| 仓库根目录 | **不得**存在 `CHANGELOG.md` 或其他变更日志文件 |

### 硬性约束

1. **每个新版本必须新建一个 `changelog/vNN.md`**，不允许把新内容追加进已有版本文件。
2. **历史版本文件只读**：一旦提交，不再修改、不再删除、不再重命名。
3. **不建任何索引文件**（不放 `changelog/README.md`、不在根目录放 `CHANGELOG.md`、不做版本汇总表）。
4. **`changelog/` 之外不写变更日志**：不走 GitHub Releases 正文代替、不写进 `README.md`。

### 文件内容结构

每个版本文件按下面的骨架写，无内容的段落直接省略：

```markdown
# vNN — 一句话主题

> 发布日期：YYYY-MM-DD

## 新增（Added）
## 改进（Changed）
## 修复（Fixed）
## 移除（Removed）
## 已知遗留 / 未生效项

## 验证
```

写作要求：

- **主题行**用一句话说清这版干了什么，不要写成版本号复述。
- **按影响分类**，而不是按文件分类。读者关心「什么变了」，不是「改了哪些文件」。
- 涉及具体行为时**带上关键数字与边界**，例如尺寸钳位 `180–1400`、超时 `5s`、限流 `30 次/分钟`、防抖 `300ms`。
- **`已知遗留 / 未生效项` 必须如实写**。代码写了但没接线、测试写了但没进 CI、配置项存在但未启用，都要记在这里。宁可显得不完整，不许让读者误以为已生效。
- **`验证` 段写可复现的结论**：测试用例条数、CI 结果、线上产物核对项。

### 版本号怎么定

- 按发布意图定，不按提交数。一次发布可以跨多个版本（如 v22 + v23 同批），此时各自建文件，或合并为一个区间文件。
- 若上游交付物（zip 等）内部已标注版本号，**以交付物为准**，不要自行重排。

---

## 发布流程

仓库为纯前端静态站点，通过 GitHub Actions 构建并发布到 GitHub Pages。

1. **解包并比对**：与当前 `HEAD` 逐文件哈希比对，确认改动范围符合预期。
2. **保护仓库维护版文件**（每版都会被交付物覆盖，必须跳过）：
   - `.github/workflows/deploy-pages.yml`
   - `src/vite-env.d.ts`
3. **写 changelog**：新建 `changelog/vNN.md`，按上面的结构填写。
4. **提交并推送** 到 `main`。
5. **等待 CI**：`typecheck` → `build` → Pages deploy 全部 success。
6. **验证线上产物**：确认资源 hash 已更新、HTTP 200、关键功能标记存在于 JS 产物中。
7. **立即删除源 zip 与临时产物**。不保留、不等待提醒。

### CI 说明

- `deploy-pages.yml` 必须保留 `cache: npm`；`package-lock.json` 缺失时会在 setup 阶段直接失败。
- Pages 是项目页子路径，`VITE_BASE_PATH` 由 workflow 解析并注入，不要硬编码 `base`。
- 需要 `.nojekyll`，否则下划线开头的资源会被 Jekyll 吞掉。

### 禁止事项

- **不要在本机执行 `npm install` / `npm run build` / `tsc`**。构建一律交给 CI。
- 不要为通过 CI 而擅自抬高 `vite` 的构建 target。若报「Top-level await is not available」，改成静态 import，而不是改 target。
- 不要删除 `.workbuddy` 目录或仓库内的既有文档。

---

## 代码约定

- 脚本沙箱（`src/core/scriptSandbox.ts`）的 token 黑名单是安全边界，**新增内置脚本或模板脚本后必须确认不命中黑名单**，并跑 `npm test` 里的全量预检用例。
- 控件连线为 DAG，建边前必须过 `validateDagConnection()`，不要绕过。
- 密钥比较一律用 `crypto.timingSafeEqual` 且先比长度，不要用 `===`。
- `import.meta.env` 的自定义变量需在 `src/vite-env.d.ts` 显式声明，不要依赖 `vite/client` 的索引签名兜底。
