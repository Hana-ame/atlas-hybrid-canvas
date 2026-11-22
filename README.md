# Atlas Hybrid Canvas — 混合无限画布完整示例

这是一个将 **React Flow（上层近景交互）**、**AtlasCanvas（底层 512×512 Chunk 离屏瓦片 + Web Worker 安全沙箱 + 防 SSRF 代理）** 与 **realtime-whiteboard（`room-go` 常驻房间 + `(rev, cid)` CRDT）** 融合在一起的可运行完整示例。

## 核心特性一览

1. **混合渲染与迟滞 LOD 切换（`src/canvas/ChunkUnderlayCanvas.tsx` + `src/App.tsx`）**
   - 底层 HTML5 Canvas 2D 与 React Flow 的 `useViewport()` 矩阵像素级对齐。
   - **近景（`zoom > 38%`）**：仅把当前可见 `512×512` Chunk 内的活跃节点交给 React Flow 挂载为原生 React 组件（支持表单、文本域、按钮与连线）。
   - **宏观全景（`zoom < 32%`）**：自动清空 React Flow 的 DOM 节点（`DOM挂载 = 0`），无缝切给底层离屏 `ChunkTileCache` 瓦片渲染，点击顶栏「生成压测大地图」即可实测 360+ 节点丝滑缩放。
2. **不可交互背景注释层（`CanvasAnnotation`）**
   - 注释文本直接烘焙进 `512×512` 静态离屏瓦片，默认鼠标点击完全穿透不误触，零 DOM 开销。
3. **权威底座 + 个人本地叠加层（`src/core/layeredStore.ts`）**
   - 后端保存权威蓝图骨架与 `defaultVars`；个人拖拽位置、编辑文本以及点击按钮跑出的运行时 `vars` 仅存本地浏览器，随时可点「重置本地状态」还原，或显式点「发布为后端底座」。
4. **隔离 Web Worker 脚本沙箱 + 防 SSRF 密钥代理（`src/core/scriptSandbox.ts` + `server/server.ts`）**
   - 控件脚本运行在一次性隔离 Web Worker 中（屏蔽 DOM/Cookie/Storage，5 秒超时强杀）。
   - 外部 API 请求经 `/api/proxy` 走 DNS 重绑定校验与内网/云元数据 IP 拦截。
5. **常驻协同房间资产（`room-go/` + `src/core/crdt.ts`）**
   - 已完整内置 `room-go` Go 无头房间服务与确定性 `(rev, cid)` CRDT 模块，可按需接入多人实时同步。

## 本地运行

```bash
# 1. 安装前端与 Express 代理依赖
npm install

# 2. 启动开发服务（同时启动 Vite 前端与 Express 后端）
npm run dev
```

打开浏览器访问 `http://localhost:3000`：
- 点击节点里的「本地计数 +1 (Worker)」体验隔离沙箱与本地运行态 `vars`；
- 点击顶栏「加穿透注释」在画板上留下不可交互背景注释；
- 点击「生成压测大地图」后滚轮缩远至 `< 32%`，观察顶部状态栏 `DOM挂载` 归零并由底层 Canvas 瓦片无缝接管。

### 启动可选 Go 常驻房间服务

```bash
cd room-go
go run . my-blueprint-room
```

## GitHub Pages 线上演示

线上版由 GitHub Actions 在云端构建并发布（`.github/workflows/deploy-pages.yml`），
推送到 `main` 即自动部署，本地无需 `npm install` 或 `npm run build`。

### 静态托管与后端的差异（重要）

Pages 只能托管静态文件，`server/server.ts` 的 Express 路由不存在。生产构建下
`src/main.tsx` 会自动装载 `src/core/mockApi.ts`，用 fetch 拦截器在浏览器内
实现**同样的接口契约**，业务代码零改动：

| 接口 | 本地（Express） | Pages（mock） |
|---|---|---|
| `GET /api/blueprint` | 内存 | `localStorage` |
| `POST /api/blueprint/publish` | 内存 + rev 自增 | `localStorage` + rev 自增 |
| `GET /api/proxy/status` | 服务端配置 | 返回白名单，`mock: true` |
| `POST /api/proxy` | 服务端代发，含内网 IP 拦截 | 浏览器直连，受目标站 CORS 限制 |

因此线上版：

- ✅ 混合渲染、迟滞 LOD、Worker 沙箱、穿透注释、本地叠加层、压测大地图 —— 全部可用
- ⚠️ 「发布为后端底座」只写进本机浏览器，**换浏览器/清缓存后回到默认**，不再是真正的多方共享权威底座
- ⚠️ 代理请求拿不到服务端密钥注入；目标域名必须允许跨域。白名单在 mock 里仍会校验，但**不做内网 IP 拦截**——浏览器侧拿不到对端 IP，写了也是假安全，故如实不实现

真正的服务端能力请本地 `npm run dev`（或把 `server/` 单独部署到你自己的主机）。
