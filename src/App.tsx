import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import { AnnotationNode, type AnnotationNodeData } from './canvas/AnnotationNode';
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
  CanvasAnnotation,
  LocalOverlayState,
  LODLevel,
  WidgetButtonSpec,
} from './core/types';

const nodeTypes = {
  widget: WidgetNode,
  annotation: AnnotationNode,
};
const SELF_CID = `client-${Math.random().toString(36).slice(2, 7)}`;

const LOD_LABELS: Record<LODLevel, string> = {
  micro: '近景精编',
  meso: '中景浏览',
  macro: '全景瓦片',
};

function HybridCanvasWorkspace() {
  const [base, setBase] = useState<BaseBlueprint>(() => createSeedBlueprint());
  const [overlay, setOverlay] = useState<LocalOverlayState>(() => createEmptyOverlay());
  const overlayHydratedRef = useRef(false);
  const [showChunkGrid, setShowChunkGrid] = useState(true);
  const [annotationEditMode, setAnnotationEditMode] = useState(false);
  const [placingAnnotation, setPlacingAnnotation] = useState(false);
  const [busyButtonKey, setBusyButtonKey] = useState<string | null>(null);
  const [statusLog, setStatusLog] = useState<string>('就绪：所有运行态 vars 与拖拽修改仅保存在本地 IndexedDB');
  const [renderVersion, setRenderVersion] = useState(0);
  const [chunkSyncTick, setChunkSyncTick] = useState(0);

  // 迟滞区间 LOD（缩小 < 0.32 切全景瓦片；放大 > 0.38 切回 React Flow DOM，防临界闪屏）
  const [lod, setLod] = useState<LODLevel>('micro');
  const vp = useViewport();
  const rf = useReactFlow();

  const chunkManagerRef = useRef<ChunkManager | null>(null);
  const tileCacheRef = useRef(new ChunkTileCache(160));
  const draggingNodeIdsRef = useRef<Set<string>>(new Set());

  const effectiveNodes = useMemo(() => resolveEffectiveNodes(base, overlay), [base, overlay]);
  const effectiveNodesRef = useRef(effectiveNodes);
  effectiveNodesRef.current = effectiveNodes;

  if (!chunkManagerRef.current) {
    const cm = new ChunkManager(512);
    cm.rebuild(effectiveNodes, base.annotations);
    chunkManagerRef.current = cm;
  }

  useEffect(() => {
    setLod((prev) => {
      if (prev !== 'macro' && vp.zoom < 0.32) return 'macro';
      if (prev === 'macro' && vp.zoom > 0.38) return vp.zoom < 0.72 ? 'meso' : 'micro';
      if (prev !== 'macro') return vp.zoom < 0.72 ? 'meso' : 'micro';
      return prev;
    });
  }, [vp.zoom]);

  // Esc 退出“点击放置注释”模式
  useEffect(() => {
    if (!placingAnnotation) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPlacingAnnotation(false);
        setStatusLog('已取消放置注释');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placingAnnotation]);

  // 仅在底座更新、注释变更、切换 LOD、切换注释编辑态或拖拽松手时重建 Chunk 索引与瓦片缓存
  const isFirstEffectRef = useRef(true);
  useEffect(() => {
    if (isFirstEffectRef.current) {
      isFirstEffectRef.current = false;
      return;
    }
    if (draggingNodeIdsRef.current.size > 0) return;
    chunkManagerRef.current?.rebuild(effectiveNodesRef.current, base.annotations);
    tileCacheRef.current.clear();
    setRenderVersion((v) => v + 1);
  }, [base.version, base.annotations, lod, annotationEditMode, chunkSyncTick]);

  // 启动时从 IndexedDB 异步恢复个人本地叠加层，并尝试拉取后端/Mock 权威底座
  useEffect(() => {
    let active = true;
    void (async () => {
      const savedOverlay = await loadLocalOverlay();
      if (!active) return;
      overlayHydratedRef.current = true;
      setOverlay(savedOverlay);
      setChunkSyncTick((t) => t + 1);

      try {
        const resp = await fetch('/api/blueprint');
        if (resp.ok) {
          const data = (await resp.json()) as { ok?: boolean; blueprint?: BaseBlueprint | null };
          if (active && data.ok && data.blueprint && data.blueprint.nodes) {
            setBase(data.blueprint);
          }
        }
      } catch {
        // 未连接后端时继续使用默认种子蓝图
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // 防抖异步写入 IndexedDB，不阻塞拖拽与渲染主线程
  useEffect(() => {
    if (!overlayHydratedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveLocalOverlay(overlay);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [overlay]);

  const handleRunButton = useCallback(async (nodeId: string, btn: WidgetButtonSpec) => {
    const entity = effectiveNodesRef.current[nodeId];
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
  }, []);

  const handleResetNodeLocal = useCallback((nodeId: string) => {
    setOverlay((prev) => {
      const nextRuntime = { ...prev.runtimeVars };
      const nextPatches = { ...prev.nodePatches };
      delete nextRuntime[nodeId];
      delete nextPatches[nodeId];
      return { ...prev, runtimeVars: nextRuntime, nodePatches: nextPatches };
    });
    setChunkSyncTick((t) => t + 1);
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

  const handleUpdateAnnotation = useCallback((id: string, patch: Partial<CanvasAnnotation>) => {
    setBase((prev) => {
      const cur = prev.annotations[id];
      if (!cur) return prev;
      return {
        ...prev,
        version: prev.version + 1,
        annotations: {
          ...prev.annotations,
          [id]: { ...cur, ...patch, rev: cur.rev + 1, cid: SELF_CID },
        },
      };
    });
  }, []);

  const handleDeleteAnnotation = useCallback((id: string) => {
    setBase((prev) => {
      const nextAnns = { ...prev.annotations };
      delete nextAnns[id];
      return { ...prev, version: prev.version + 1, annotations: nextAnns };
    });
    setStatusLog('已删除背景注释');
  }, []);

  // 近/中景时挂载可见 Chunk 的控件节点；若开启“注释编辑模式”，额外挂载可拖拽注释节点
  const rfNodes: Node[] = useMemo(() => {
    if (lod === 'macro' || !chunkManagerRef.current) return [];
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
    const visibleAnnIds = new Set<string>();
    for (const c of visibleChunks) {
      for (const id of c.nodeIds) visibleIds.add(id);
      if (annotationEditMode) {
        for (const aid of c.annotationIds) visibleAnnIds.add(aid);
      }
    }
    for (const id of draggingNodeIdsRef.current) {
      if (id.startsWith('ann-node:')) {
        visibleAnnIds.add(id.slice('ann-node:'.length));
      } else {
        visibleIds.add(id);
      }
    }

    const list: Node[] = [];
    if (annotationEditMode) {
      for (const aid of visibleAnnIds) {
        const ann = base.annotations[aid];
        if (!ann) continue;
        list.push({
          id: `ann-node:${ann.id}`,
          type: 'annotation',
          position: { x: ann.x, y: ann.y },
          zIndex: 0,
          data: {
            annotation: ann,
            onUpdateAnnotation: handleUpdateAnnotation,
            onDeleteAnnotation: handleDeleteAnnotation,
          } satisfies AnnotationNodeData,
        });
      }
    }

    for (const id of visibleIds) {
      const entity = effectiveNodes[id];
      if (!entity) continue;
      list.push({
        id: entity.id,
        type: 'widget',
        position: { x: entity.x, y: entity.y },
        zIndex: 10,
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
  }, [
    lod,
    vp.x,
    vp.y,
    vp.zoom,
    effectiveNodes,
    base.annotations,
    annotationEditMode,
    handleRunButton,
    handleResetNodeLocal,
    handleEditBody,
    handleUpdateAnnotation,
    handleDeleteAnnotation,
    busyButtonKey,
    renderVersion,
  ]);

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

  // 拖拽节点写入个人叠加层；拖拽注释（编辑模式下）直接更新注释坐标
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const widgetMoves: Array<{ id: string; x: number; y: number }> = [];
    const annMoves: Array<{ id: string; x: number; y: number }> = [];
    let anyDragEnded = false;

    for (const ch of changes) {
      if (ch.type === 'position') {
        if (ch.dragging === true) {
          draggingNodeIdsRef.current.add(ch.id);
        }
        if (ch.position) {
          const x = ch.dragging === false ? Math.round(ch.position.x) : ch.position.x;
          const y = ch.dragging === false ? Math.round(ch.position.y) : ch.position.y;
          if (ch.id.startsWith('ann-node:')) {
            annMoves.push({ id: ch.id.slice('ann-node:'.length), x, y });
          } else {
            widgetMoves.push({ id: ch.id, x, y });
          }
        }
        if (ch.dragging === false) {
          draggingNodeIdsRef.current.delete(ch.id);
          anyDragEnded = true;
        }
      }
    }

    if (widgetMoves.length > 0) {
      setOverlay((prev) => {
        const nextPatches = { ...prev.nodePatches };
        for (const u of widgetMoves) {
          nextPatches[u.id] = {
            ...(nextPatches[u.id] ?? {}),
            x: u.x,
            y: u.y,
          };
        }
        return { ...prev, nodePatches: nextPatches };
      });
    }

    if (annMoves.length > 0) {
      setBase((prev) => {
        const nextAnns = { ...prev.annotations };
        for (const u of annMoves) {
          const cur = nextAnns[u.id];
          if (cur) nextAnns[u.id] = { ...cur, x: u.x, y: u.y };
        }
        return { ...prev, annotations: nextAnns };
      });
    }

    if (anyDragEnded) {
      setChunkSyncTick((t) => t + 1);
    }
  }, []);

  // 点击画布空白处放置新背景注释（支持任意位置选点！）
  const handlePaneClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!placingAnnotation) return;
      const worldPos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const text = window.prompt('输入不可交互背景注释文本：', '新分区注释：仅供视觉引导');
      setPlacingAnnotation(false);
      if (!text) return;

      const id = `ann-${Date.now()}`;
      setBase((prev) => ({
        ...prev,
        version: prev.version + 1,
        annotations: {
          ...prev.annotations,
          [id]: {
            id,
            x: Math.round(worldPos.x),
            y: Math.round(worldPos.y),
            width: 420,
            text,
            fontSize: 18,
            color: '#0F766E',
            weight: 'bold',
            nonInteractive: true,
            rev: 1,
            cid: SELF_CID,
          },
        },
      }));
      setStatusLog(`已在 (${Math.round(worldPos.x)}, ${Math.round(worldPos.y)}) 添加背景注释`);
    },
    [placingAnnotation, rf]
  );

  const handlePublishToBackend = async () => {
    const merged = applyOverlayToBase(base, overlay, SELF_CID);
    setBase(merged);
    setOverlay((prev) => ({ ...prev, nodePatches: {} }));
    setChunkSyncTick((t) => t + 1);
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
    setStatusLog('已生成 360+ 跨区压测节点！缩远至 < 32% 可体验全景瓦片与清晰大字标题');
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 80);
  };

  return (
    <div className={`relative h-full w-full overflow-hidden ${placingAnnotation ? 'cursor-crosshair' : ''}`}>
      {/* 顶栏精简控制台 */}
      <div className="pointer-events-auto absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur">
        <span className="font-mono text-xs font-bold text-slate-900">
          视图:{' '}
          <span className={lod === 'macro' ? 'text-teal-700' : 'text-blue-700'}>
            {LOD_LABELS[lod]}
          </span>{' '}
          ({Math.round(vp.zoom * 100)}%)
        </span>
        <span className="font-mono text-xs text-slate-500">
          总节点 {Object.keys(effectiveNodes).length} · DOM挂载 {rfNodes.length} · 瓦片 {tileCacheRef.current.size}
        </span>

        <button
          type="button"
          onClick={() => {
            setPlacingAnnotation((v) => {
              const next = !v;
              setStatusLog(next ? '请直接点击画布任意位置放置注释（按 Esc 取消）' : '已取消放置注释');
              return next;
            });
          }}
          className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium text-white ${
            placingAnnotation ? 'bg-amber-600 hover:bg-amber-700' : 'bg-teal-700 hover:bg-teal-800'
          }`}
        >
          <Plus className="h-3.5 w-3.5" />
          {placingAnnotation ? '点画布选位置…(Esc取消)' : '点选放置注释'}
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
          onClick={() => {
            setAnnotationEditMode((v) => {
              const next = !v;
              setStatusLog(
                next
                  ? '已解锁注释层：现在可以拖动、改字、调字号或删除背景注释'
                  : '已锁定注释层：背景注释恢复点击穿透并烘焙进底层瓦片'
              );
              return next;
            });
          }}
          className={`rounded border px-2 py-1 text-xs ${
            annotationEditMode
              ? 'border-amber-500 bg-amber-50 text-amber-900'
              : 'border-slate-300 bg-white text-slate-700'
          }`}
        >
          {annotationEditMode ? '注释模式：可拖动编辑' : '注释模式：已锁定穿透'}
        </button>

        <button
          type="button"
          onClick={() => {
            setOverlay(createEmptyOverlay());
            setChunkSyncTick((t) => t + 1);
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
        onPaneClick={handlePaneClick}
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
          annotationEditMode={annotationEditMode}
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
