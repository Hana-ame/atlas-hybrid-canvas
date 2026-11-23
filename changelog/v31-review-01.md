# v31 代码审查 — 01

> 审查日期：2026-11-23
> 审查范围：v31 相对 v30 的全部改动（PDF 阅读控件、服务端二进制代理与上传接口）
> 结论：**可发布**，URL 协议校验、SSRF 防护、魔数校验与 Blob 生命周期均到位，无阻断问题

## 改动范围核对

| 文件 | 变化 | 判定 |
| --- | --- | --- |
| `src/core/pdfHelper.ts` / `tests/pdfHelper.test.ts` | 新增安全 URL 校验、页码规范化、内置演示 PDF 与 3 条单测 | 边界清晰，拦截 `javascript:`/`data:` |
| `src/canvas/PdfViewerBlock.tsx` / `WidgetNode.tsx` | 新增独立 PDF 阅读组件并接入 `renderLeafBlock` | `nodrag nopan nowheel` 隔离良好，卸载释放 Blob URL |
| `server/server.ts` | 新增 `/api/proxy/binary` 与 `/api/pdf/upload` / `/api/pdf/:id` | 完整复用 SSRF、限流与魔数校验 |
| `src/core/types.ts` / `seedBlueprint.ts` / `widgetTemplates.ts` | 扩展流式块类型并新增示例与模板 | 通过全量模板编译与黑名单测试 |
| `.github/workflows/deploy-pages.yml` / `src/vite-env.d.ts` | 未改动 | 符合 `AGENTS.md` 保护清单 |

## 审查发现

### 已确认正确

- **协议与文件头双校验**：前端 `isSafePdfUrl` 拒绝 `javascript:` 与 `data:text/html`；后端 `/api/pdf/upload` 强制校验 `%PDF` 文件头与 `15MB` 大小上限，`/api/pdf/:id` 仅用随机 16 位 hex ID 寻址无路径穿越。
- **SSRF 与限流复用**：`/api/proxy/binary` 完整经过 `checkProxyRateLimit`、`verifyProxyClientToken`、`validateProxyTargetUrl` 与 `dns.lookup` 内网 IP 检查。
- **显存/内存回收**：`PdfViewerBlock` 卸载时自动 `URL.revokeObjectURL` 清理本地创建的 Blob URL；服务端 `uploadedPdfStore` 上限 20 份自动淘汰最旧条目。

### 非阻断问题

**1. 浏览器原生 iframe PDF 翻页依赖内置 PDF 查看器对 `#page=N` 的支持**

桌面端 Chrome / Edge / Firefox / Safari 均支持通过重设 iframe `key` 跳转到 `#page=N`；部分移动端浏览器默认触发下载而非内嵌渲染。

- 影响面：仅移动端浏览器。
- 处理：零外部依赖方案下保持原生渲染，记入已知说明。

### 阻断问题

无。

## 验证记录

- `npm test`：20 / 20 全部通过。
- `npm run typecheck`：0 报错。
- `npm run build`：通过，主产物 `index-DuoTBoC0.js`（`579045` 字节）。
