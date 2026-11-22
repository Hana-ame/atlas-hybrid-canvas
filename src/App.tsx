import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  useReactFlow,
  useViewport,
  type Node,
  type Edge,
  type NodeChange,
} from '@xyflow/react';
import { Layers, Plus, RotateCcw, UploadCloud, Zap } from 'lucide-react';
import { ChunkUnderlayCanvas } from './canvas/ChunkUnderlayCanvas';
import { WidgetNode, type WidgetNodeData } from './canvas/WidgetNode';
import { ChunkManager } from './core/chunkManager';
import { ChunkTileCache } from './core/chunkTileCache';
import {
  applyOverlayToBase,
  createEmptyOverlay,
  loadLocalOverlay,
  resolveEffectiveNodes,
  saveLocalOverlay,
} from './core/layeredStore';
import { runInIsolatedWorker } from './core/scriptSandbox';
import { createSeedBlueprint, spawnStressChunks } from './core/seedBlueprint';
import type {
  BaseBlueprint,
  LocalOverlayState,
  LODLevel,
  WidgetButtonSpec,
} from './core/types';

const nodeTypes = { widget: WidgetNode };
const SELF_CID = `client-${Math.random().toString(36).slice(2, 7)}`;

function HybridCanvasWorkspace() {
  const [base, setBase] = useState<BaseBlueprint>(() => createSeedBlueprint());
  const [overlay, setOverlay] = useState<LocalOverlayState>(() => loadLocalOverlay());
  const [showChunkGrid, setShowChunkGrid] = useState(true);
  const [annotationEditMode, setAnnotationEditMode] = useState(false);
  const [busyButtonKey, setBusyButtonKey] = useState<string | null>(null);
  const [statusLog, setStatusLog] = useState<string>('就绪：所有运行态 vars 与拖拽修改仅保存在本地浏览器');
  const [renderVersion, setRenderVersion] = useState(0);

  // 迟滞区间 LOD（缩小 < 0.32 切纯 Canvas 瓦片；放大 > 0.38 切回 React Flow DOM，防临界闪屏）
  const [lod, setLod] = useState<LODLevel>('micro');
  const vp = useViewport();
  const rf = useReactFlow();

  const chunkManagerRef = useRef(new ChunkManager(512));
  const tileCacheRef = useRef(new ChunkTileCache(160));

  useEffect(() => {
    setLod((prev) => {
      if (prev !== 'macro' && vp.zoom < 0.32) return 'macro';
      if (prev === 'macro' && vp.zoom > 0.38) return vp.zoom < 0.72 ? 'meso' : 'micro';
      if (prev !== 'macro') return vp.zoom < 0.72 ? 'meso' : 'micro';
      return prev;
    });
  }, [vp.zoom]);

  const effectiveNodes = useMemo(() => resolveEffectiveNodes(base, overlay), [base, overlay]);

  // 底座或本地位置变化时重建 Chunk 空间哈希索引并标记脏瓦片
  useEffect(() => {
    chunkManagerRef.current.rebuild(effectiveNodes, base.annotations);
    tileCacheRef.current.clear();
    setRenderVersion((v) => v + 1);
  }, [effectiveNodes, base.annotations]);

  useEffect(() => {
    saveLocalOverlay(overlay);
  }, [overlay]);

  const handleRunButton = useCallback(
    async (nodeId: string, btn: WidgetButtonSpec) => {
      const entity = effectiveNodes[nodeId];
      if (!entity) return;
      const key = `${nodeId}:${btn.id}`;
      setBusyButtonKey(key);

      try {
        if (btn.actionType === 'script' && btn.code) {
          const res = await runInIsolatedWorker(btn.code, entity.effectiveVars);
          if (!res.ok) {
            setStatusLog(`沙箱拦截/报错：${res.error}`);
            return;
          }
          setOverlay((prev) => ({
            ...prev,
            runtimeVars: {
              ...prev.runtimeVars,
              [nodeId]: res.updatedVars,
            },
          }));
          setStatusLog(res.logs.length > 0 ? `Worker 输出：${res.logs.join(' | ')}` : `已更新本地 vars (${entity.title})`);
        } else if (btn.actionType === 'proxy_http' && btn.proxyUrl) {
          const resp = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: btn.proxyUrl, method: btn.proxyMethod || 'GET' }),
          });
          const data = (await resp.json()) as { ok: boolean; status?: number; error?: string };
          setOverlay((prev) => ({
            ...prev,
            runtimeVars: {
              ...prev.runtimeVars,
              [nodeId]: {
                ...(prev.runtimeVars[nodeId] ?? {}),
                lastHttpStatus: data.ok ? data.status ?? 200 : data.error ?? 'error',
              },
            },
          }));
          setStatusLog(data.ok ? `服务端代理请求成功 (HTTP ${data.status})` : `代理被拦截或失败：${data.error}`);
        }
      } finally {
        setBusyButtonKey(null);
      }
    },
    [effectiveNodes]
  );

  const handleResetNodeLocal = useCallback((nodeId: string) => {
    setOverlay((prev) => {
      const nextRuntime = { ...prev.runtimeVars };
      const nextPatches = { ...prev.nodePatches };
      delete nextRuntime[nodeId];
      delete nextPatches[nodeId];
      return { ...prev, runtimeVars: nextRuntime, nodePatches: nextPatches };
    });
    setStatusLog('已将该节点重置为后端权威默认值');
  }, []);

  const handleEditBody = useCallback((nodeId: string, nextBody: string) => {
    setOverlay((prev) => ({
      ...prev,
      nodePatches: {
        ...prev.nodePatches,
        [nodeId]: { ...(prev.nodePatches[nodeId] ?? {}), body: nextBody },
      },
    }));
  }, []);

  // 近景时仅把当前视口可见 Chunk 里的节点挂载给 React Flow；缩远到 Macro 时返回空数组（0 个 DOM 节点！）
  const rfNodes: Node[] = useMemo(() => {
    if (lod === 'macro') return [];
    const width = window.innerWidth || 1280;
    const height = window.innerHeight || 800;
    const worldBounds = {
      minX: -vp.x / vp.zoom - 256,
      minY: -vp.y / vp.zoom - 256,
      maxX: (width - vp.x) / vp.zoom + 256,
      maxY: (height - vp.y) / vp.zoom + 256,
    };
    const visibleChunks = chunkManagerRef.current.queryVisibleChunks(worldBounds);
    const visibleIds = new Set<string>();
    for (const c of visibleChunks) {
      for (const id of c.nodeIds) visibleIds.add(id);
    }

    const list: Node[] = [];
    for (const id of visibleIds) {
      const entity = effectiveNodes[id];
      if (!entity) continue;
      list.push({
        id: entity.id,
        type: 'widget',
        position: { x: entity.x, y: entity.y },
        data: {
          entity,
          onRunButton: handleRunButton,
          onResetLocal: handleResetNodeLocal,
          onEditBody: handleEditBody,
          busyButtonKey,
        } satisfies WidgetNodeData,
      });
    }
    return list;
  }, [lod, vp.x, vp.y, vp.zoom, effectiveNodes, handleRunButton, handleResetNodeLocal, handleEditBody, busyButtonKey]);

  const rfEdges: Edge[] = useMemo(() => {
    if (lod === 'macro') return [];
    return Object.values(base.edges).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: Boolean(e.dashed),
      style: { stroke: e.color || '#64748B', strokeWidth: 2 },
    }));
  }, [lod, base.edges]);

  // 拖拽节点只写入个人本地叠加层（LocalOverlay），不直接污染后端权威底座
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'position' && ch.position) {
        const { id, position } = ch;
        setOverlay((prev) => ({
          ...prev,
          nodePatches: {
            ...prev.nodePatches,
            [id]: {
              ...(prev.nodePatches[id] ?? {}),
              x: Math.round(position.x),
              y: Math.round(position.y),
            },
          },
        }));
      }
    }
  }, []);

  const handleAddBackgroundAnnotation = () => {
    const centerX = Math.round((window.innerWidth * 0.5 - vp.x) / vp.zoom - 140);
    const centerY = Math.round((window.innerHeight * 0.5 - vp.y) / vp.zoom - 20);
    const text = window.prompt('输入不可交互背景注释文本（将直接烘焙进静态瓦片）：', '新分区注释：仅供视觉引导');
    if (!text) return;
    const id = `ann-${Date.now()}`;
    setBase((prev) => ({
      ...prev,
      version: prev.version + 1,
      annotations: {
        ...prev.annotations,
        [id]: {
          id,
          x: centerX,
          y: centerY,
          width: 420,
          text,
          fontSize: 16,
          color: '#0F766E',
          weight: 'bold',
          nonInteractive: true,
          rev: 1,
          cid: SELF_CID,
        },
      },
    }));
    setStatusLog('已添加不可交互背景注释（鼠标点击将直接穿透）');
  };

  const handlePublishToBackend = async () => {
    const merged = applyOverlayToBase(base, overlay, SELF_CID);
    setBase(merged);
    setOverlay((prev) => ({ ...prev, nodePatches: {} }));
    try {
      const res = await fetch('/api/blueprint/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: merged }),
      });
      const json = (await res.json()) as { ok: boolean; serverRevision?: number };
      setStatusLog(json.ok ? `已发布为后端新权威底座 (rev #${json.serverRevision})` : '发布失败');
    } catch {
      setStatusLog('已在本地更新权威底座（未连接后端服务）');
    }
  };

  const handleSpawnStress = () => {
    setBase((prev) => spawnStressChunks(prev));
    setStatusLog('已生成 360+ 跨区压测节点！试着将滚轮缩远至 < 32% 观察 0 DOM 瓦片接管');
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 80);
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 顶栏精简控制台 */}
      <div className="pointer-events-auto absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur">
        <span className="font-mono text-xs font-bold text-slate-900">
          LOD: <span className={lod === 'macro' ? 'text-teal-700' : 'text-blue-700'}>{lod.toUpperCase()}</span> ({Math.round(vp.zoom * 100)}%)
        </span>
        <span className="font-mono text-xs text-slate-500">
          总节点 {Object.keys(effectiveNodes).length} · DOM挂载 {rfNodes.length} · 瓦片 {tileCacheRef.current.size}
        </span>

        <button
          type="button"
          onClick={handleAddBackgroundAnnotation}
          className="inline-flex items-center gap-1 rounded bg-teal-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-800"
        >
          <Plus className="h-3.5 w-3.5" />
          加穿透注释
        </button>

        <button
          type="button"
          onClick={handleSpawnStress}
          className="inline-flex items-center gap-1 rounded bg-blue-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-800"
        >
          <Zap className="h-3.5 w-3.5" />
          生成压测大地图
        </button>

        <button
          type="button"
          onClick={() => setShowChunkGrid((v) => !v)}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
        >
          <Layers className="h-3.5 w-3.5" />
          {showChunkGrid ? '隐藏 Chunk 网格' : '显示 Chunk 网格'}
        </button>

        <button
          type="button"
          onClick={() => setAnnotationEditMode((v) => !v)}
          className={`rounded border px-2 py-1 text-xs ${
            annotationEditMode
              ? 'border-amber-500 bg-amber-50 text-amber-900'
              : 'border-slate-300 bg-white text-slate-700'
          }`}
        >
          {annotationEditMode ? '注释模式：可编辑' : '注释模式：已锁定穿透'}
        </button>

        <button
          type="button"
          onClick={() => {
            setOverlay(createEmptyOverlay());
            setStatusLog('已清空所有个人本地叠加层，恢复后端权威默认值');
          }}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重置本地状态
        </button>

        <button
          type="button"
          onClick={handlePublishToBackend}
          className="inline-flex items-center gap-1 rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
        >
          <UploadCloud className="h-3.5 w-3.5" />
          发布为后端底座
        </button>
      </div>

      {/* 底部状态日志条 */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-slate-200 bg-white/90 px-4 py-1.5 text-xs text-slate-700 shadow-sm backdrop-blur">
        {statusLog}
      </div>

      {/* 上层 React Flow + 底层同步 Canvas 瓦片层 */}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        minZoom={0.12}
        maxZoom={2.5}
        defaultViewport={{ x: 80, y: 80, zoom: 0.9 }}
        style={{ background: 'transparent' }}
      >
        <ChunkUnderlayCanvas
          chunkManager={chunkManagerRef.current}
          tileCache={tileCacheRef.current}
          nodes={effectiveNodes}
          annotations={base.annotations}
          lod={lod}
          showChunkGrid={showChunkGrid}
          renderVersion={renderVersion}
        />
        <Controls position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <HybridCanvasWorkspace />
    </ReactFlowProvider>
  );
}
