# Atlas Hybrid Canvas — 混合无限画布蓝图框架（v98）

**Atlas Hybrid Canvas** 是一套面向**大空间蓝图、策划大地图、知识地图与可编程工作台**的混合渲染无限画布项目。它结合了三套架构的各自长板：

- **上层近景交互（`@xyflow/react`）**：原生 React DOM 控件、多入/出箭头端口、边框自由缩放（`NodeResizer`）、中文输入法原生支持、所见即所得左侧拖放模板库。
- **底层无限空间调度（源自 AtlasCanvas）**：`512×512` 正负无限坐标空间哈希分区（`ChunkManager`）、LRU 离屏瓦片缓存（`ChunkTileCache`）、迟滞 LOD 切换（`< 32%` 清空 DOM 切纯瓦片 + 全景大字截断）、Web Worker 安全脚本沙箱与防 SSRF 服务端密钥代理。
- **协同资产（源自 realtime-whiteboard）**：内建 Node WebSocket 房间服务（`server/roomServer.ts`，与 Express 共用同一端口）与确定性 `(rev, cid)` CRDT 模块（`src/core/crdt.ts`），`npm run dev` 即可开启多人实时同步。

## 架构分层一览

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ 上层 React Flow DOM 交互层（zoom > 38% 仅挂载当前可见 Chunk 活跃节点）     │
│  · WidgetNode（默认整卡可拖、双击编辑标题/正文、多入/出端口、vars.contents）│
│  · ControllableEdge（控制点样条避让、标签画布内联编辑、4px 阈值拖拽状态机） │
│  · AnnotationNode（编辑态解锁的文本框与等比插图，关闭后自动回归底层瓦片）   │
├─────────────────────────────────────────────────────────────────────────┤
│ 底层同步 Canvas 2D 瓦片层（ChunkUnderlayCanvas，Zustand 零重渲染同步）    │
│  · 512×512 无限网格与坐标水印                                            │
│  · 不可交互背景文本框（多行换行 + 色块）与等比插图（contain 不拉伸）       │
│  · 全景视图（zoom < 32%）：0 DOM 挂载，色块走瓦片 + 屏幕像素补偿大字标题   │
├─────────────────────────────────────────────────────────────────────────┤
│ 双层状态与异步持久化层（src/core/layeredStore.ts + idbStorage.ts）        │
│  · BaseBlueprint（后端权威底座，保存需校验 X-Blueprint-Save-Key）         │
│  · LocalOverlay（个人运行态 vars、本地补丁、背景覆盖，全量存 IndexedDB）   │
├─────────────────────────────────────────────────────────────────────────┤
│ 隔离执行与安全代理层（src/core/scriptSandbox.ts + server/server.ts）      │
│  · 一次性 Blob Web Worker（5s 强杀 + 危险全局拦截）                       │
│  · Express /api/proxy（DNS 校验 + 内网/元数据 IP 拦截 + 白名单密钥注入）   │
└─────────────────────────────────────────────────────────────────────────┘
```

## 核心特性

1. **无限空间与混合 LOD 调度**：`512×512` 是分区瓦片单元尺寸，画布正负方向无限延伸；支持近景精编（≥72%）、中景浏览（32%–72%）与全景瓦片（<32%，0 DOM 挂载）三档迟滞切换。
2. **完整控件编辑与所见即所得拖放模板库**：
   - 内置 13+ 精选模板（知识概念卡、里程碑、对比决策卡、世界观区域、剧情关卡、角色档案、API 服务、监控指标、路由网关、跨控件联动控制台、空白控件、色块文本框、透明大标题、等比背景插图），左侧直接拖到画布任意位置创建；
   - 支持将任意改好的控件一键**「存为模板」**（持久化到 IndexedDB「我的模板」）；
   - 默认**整卡按住可拖动**，**双击**标题或正文进入编辑，点右上角 `⚙` 打开右侧属性/端口/按钮/脚本编辑器，支持🔒锁定防误拖。
3. **两类背景注释层（文本框 + 等比插图）**：平时完全点击穿透且烘焙进离屏瓦片；开启「注释层：可拖动编辑」后可调字号、字色、色块底色（含透明）、上传本地插图与等比缩放，且支持被控件脚本动态改变背景（`canvas.setAnnotationBg` 等）。
4. **声明式流式 UI 与跨控件联动脚本**：支持在隔离 Web Worker 中通过 `vars.contents` 渲染文本、按钮、原生 `<input>`/`<textarea>` 和水平行排布 `[...]`，支持 `on`、`onSubmit`、`widgets.create/connect/remove/get/vars`、`emit`、`broadcast`；内置开箱可玩的「示例：一键创建并联动控件」。
5. **权威底座 + 个人本地叠加层 + 保存鉴权**：所有运行时 `vars` 和个人修改默认只存当前浏览器 IndexedDB（零 `localStorage`），支持单节点或全局一键还原；点顶栏「保存（需 Key）」需校验 `X-Blueprint-Save-Key`，无密钥访客仅可通过控件内预设 API 访问后端。
6. **可控连线与画布内联标签编辑**：连线可插入最多 12 个控制点，采用 Centripetal Catmull-Rom（α = 0.5）转三次贝塞尔样条，平滑穿过全部控制点且疏密不均时不会过冲出包围盒；近景 SVG 与全景 `macro` Canvas 共用同一套几何，缩放后走线完全一致。标签在曲线弧长中点**原地**变为输入框，不弹任何原生对话框。

## 连线交互（控制点与标签）

| 操作 | 效果 |
| --- | --- |
| 双击连线本体 / 双击标签胶囊 | 在标签位置原地弹出内联输入框；`Enter` 或失焦提交，`Esc` 取消，中文输入法组合期不会误提交 |
| `Alt + 双击` 连线 | 在最近线段插入控制点；普通双击与 `Shift + 双击` 一律放行给标签编辑 / 框选 |
| 左键拖动控制点 | 4px 屏幕位移阈值后开始调整弯曲路径；`pointercancel` 严格回滚 |
| 双击 / 右键控制点 | 删除该控制点，右键不会因后续 `pointerup` 被复活 |
| 点击或拖出每段曲线中点的「+」 | 新增弯折点；与标签胶囊重合时手柄自动下移 22px 避让 |

控制手柄带 `nodrag nopan` 与显式 `pointer-events: all`，不会触发画布平移；外发光与「+」内十字均为 `pointer-events: none`，只由外层命中圆承担拖拽。只读模式（无保存权限）仅展示控制点，不提供拖拽与插入入口。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量配置（可按需修改 BLUEPRINT_SAVE_KEY 与代理白名单）
cp .env.example .env

# 3. 启动开发服务（同时拉起 Vite 前端与 Express 真后端）
npm run dev
```

访问 `http://localhost:3000` 即可体验。常用命令：

```bash
npm run typecheck   # TypeScript 严格类型检查 (tsc --noEmit)
npm test            # node:test 单元测试（几何、agentOps、UI 组件，含独立回归用例）
npm run build       # 构建生产静态产物到 dist/（静态部署自动启用 IndexedDB Mock API）
```

> 静态部署（GitHub Pages / 纯静态预览）默认演示保存密钥为 `atlas-demo-key`（可通过构建环境变量 `VITE_MOCK_SAVE_KEY` 覆盖）。

## 目录结构

```text
├── docs/                           # 专题工程与开发文档
│   ├── ARCHITECTURE.md             # 混合渲染架构、防频闪原理与双层状态设计
│   ├── SCRIPT_API_GUIDE.md         # 统一脚本、vars.contents、跨控件联动与沙箱安全手册
│   ├── BACKEND_AND_SECURITY.md     # 后端 REST 契约、Save Key 鉴权、防 SSRF 代理与协同房间说明
│   └── EXTENSION_GUIDE.md          # 新增组件类型、注释类型与模板库二次开发指南
├── server/
│   ├── server.ts                   # Express 后端（权威底座读写 + Save Key 鉴权 + /api/proxy）
│   ├── roomServer.ts               # WebSocket 协同房间服务（/ws，与 Express 共用端口）
│   ├── pdfUnpack.ts                # PDF 逐页光栅化（pdftoppm / mutool）
│   └── proxySecurity.ts            # SSRF 防护、私有 IP/DNS 校验与请求头清洗
└── src/
    ├── App.tsx                     # 顶层工作台编排（受控 rfNodes、LOD 迟滞、脚本调度、保存弹窗）
    ├── main.tsx                    # 入口文件（生产静态模式自动挂载 mockApi）
    ├── canvas/
│   ├── ChunkUnderlayCanvas.tsx # 零重渲染底层 Canvas 2D 瓦片、背景文本框/插图与全景大字层
│   ├── ControllableEdge.tsx    # 可拖拽控制点连线与标签画布内联编辑（4px 阈值拖拽状态机）
│   ├── WidgetNode.tsx          # React Flow 控件节点（整卡拖动、双击编辑、多端口、流式 UI）
│   └── AnnotationNode.tsx      # 注释编辑态组件（文本框与等比插图、色板/底色/换图工具栏）
    ├── components/
    │   ├── TemplateDrawer.tsx      # 左侧所见即所得拖放模板库抽屉
    │   └── NodeInspectorPanel.tsx  # 右侧控件属性、端口、统一脚本、按钮与变量编辑器
    └── core/
        ├── types.ts                # 全局核心 TypeScript 类型定义
        ├── chunkManager.ts         # 512×512 无限坐标空间哈希分区索引
        ├── chunkTileCache.ts       # LRU 离屏 Canvas 瓦片缓存
        ├── layeredStore.ts         # 权威底座 + 个人本地叠加层合并与发布逻辑
        ├── idbStorage.ts           # 零依赖异步 IndexedDB 键值封装
        ├── scriptSandbox.ts        # 静态安全扫描 + 一次性 Blob Web Worker 隔离执行引擎
        ├── edgePath.ts             # 控制点样条几何、弧长中点、端口定位与拖拽状态机（SVG/Canvas 共用）
        ├── agentOps.ts             # Agent 工具 schema、蓝图摘要与批量操作归一化
        ├── widgetTemplates.ts      # 13+ 内置模板与 IndexedDB 自定义模板存取
        ├── seedBlueprint.ts        # 默认种子蓝图（含 example-spawner 联动示例与压测生成器）
        ├── mockApi.ts              # 静态站浏览器内 Mock 后端（契约与真后端完全一致）
        └── crdt.ts                 # 确定性 (rev, cid) LWW 冲突裁决与增量 Diff
```

## 专题文档导航

- 架构设计与防频闪工程详解：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- 控件脚本、流式 UI 与跨控件联动 API：[docs/SCRIPT_API_GUIDE.md](./docs/SCRIPT_API_GUIDE.md)
- 后端接口、保存密钥鉴权与安全代理：[docs/BACKEND_AND_SECURITY.md](./docs/BACKEND_AND_SECURITY.md)
- 二次开发与组件/模板扩展指南：[docs/EXTENSION_GUIDE.md](./docs/EXTENSION_GUIDE.md)
