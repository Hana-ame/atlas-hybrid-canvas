/**
 * @file App.tsx
 * @description Atlas Hybrid Canvas 顶层工作台容器。
 * 核心职责：
 * 1. 维护权威底座（BaseBlueprint）与个人叠加层（LocalOverlayState，IndexedDB 异步持久化）；
 * 2. 使用 React Flow v12 受控状态 + applyNodeChanges 保持节点 measured/dragging 稳定，根治拖动频闪；
 * 3. 通过粗粒度 viewportBucketKey 与迟滞 LOD（<32% / >38%）协调上层 DOM 与底层 Canvas 瓦片交接；
 * 4. 统一调度 Web Worker 控件脚本（vars.contents / widgets.create / emit / broadcast / canvas 改背景）；
 * 5. 提供左侧所见即所得拖放模板库、右侧属性脚本编辑器及带 X-Blueprint-Save-Key 鉴权的保存弹窗。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MarkerType,
  applyNodeChanges,
  useReactFlow,
  useStore,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import {
  LayoutGrid,
  Layers,
  Plus,
  RotateCcw,
  KeyRound,
  Save,
  Zap,
} from 'lucide-react';
import { AnnotationNode, type AnnotationNodeData } from './canvas/AnnotationNode';
import { ChunkUnderlayCanvas } from './canvas/ChunkUnderlayCanvas';
import { WidgetNode, type WidgetNodeData } from './canvas/WidgetNode';
import { NodeInspectorPanel } from './components/NodeInspectorPanel';
import { TEMPLATE_DRAG_MIME, TemplateDrawer } from './components/TemplateDrawer';
import { ChunkManager } from './core/chunkManager';
import { ChunkTileCache } from './core/chunkTileCache';
import {
  applyOverlayToBase,
  createEmptyOverlay,
  loadLocalOverlay,
  resolveEffectiveAnnotations,
  resolveEffectiveNodes,
  saveLocalOverlay,
} from './core/layeredStore';
import { runInIsolatedWorker, type PeerWidgetSnapshot, type ScriptTriggerEvent } from './core/scriptSandbox';
import { createSeedBlueprint, spawnStressChunks } from './core/seedBlueprint';
import {
  BUILTIN_TEMPLATES,
  loadCustomTemplates,
  nodeToCustomTemplate,
  saveCustomTemplates,
} from './core/widgetTemplates';
import type {
  BaseBlueprint,
  BlueprintNode,
  BlueprintTemplate,
  CanvasAnnotation,
  EffectiveBlueprintNode,
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

function ZoomBadge({ lod }: { lod: LODLevel }) {
  const zoomPct = useStore((s) => Math.round(s.transform[2] * 100));
  return (
    <span className="ml-1 font-mono text-xs font-bold text-slate-800">
      <span className={lod === 'macro' ? 'text-teal-700' : 'text-blue-700'}>
        {LOD_LABELS[lod]}
      </span>{' '}
      ({zoomPct}%)
    </span>
  );
}

function HybridCanvasWorkspace() {
  const [base, setBase] = useState<BaseBlueprint>(() => createSeedBlueprint());
  const [overlay, setOverlay] = useState<LocalOverlayState>(() => createEmptyOverlay());
  const [customTemplates, setCustomTemplates] = useState<BlueprintTemplate[]>([]);
  const overlayHydratedRef = useRef(false);

  const [showChunkGrid, setShowChunkGrid] = useState(true);
  const [annotationEditMode, setAnnotationEditMode] = useState(false);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(true);
  const [inspectingNodeId, setInspectingNodeId] = useState<string | null>(null);
  const [busyButtonKey, setBusyButtonKey] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveKeyInput, setSaveKeyInput] = useState('');
  const [saveKeyError, setSaveKeyError] = useState<string | null>(null);
  const [isSavingBase, setIsSavingBase] = useState(false);
  const [statusLog, setStatusLog] = useState<string>('就绪：直接从左侧拖出控件放到画布，拖动过程零频闪');
  const [renderVersion, setRenderVersion] = useState(0);
  const [chunkSyncTick, setChunkSyncTick] = useState(0);

  // 关键修复：使用 React Flow 原生受控 nodes 状态 + applyNodeChanges，
  // 彻底保留 React Flow v12 内部的 measured / dragging / selected 状态，消除拖动控件时高频消失再出现！
  const [rfNodes, setRfNodes] = useState<Node[]>([]);

  const [lod, setLod] = useState<LODLevel>('micro');
  const rf = useReactFlow();
  const rfStore = useStoreApi();

  const viewportBucketKey = useStore((s) => {
    const [tx, ty, zoom] = s.transform;
    const w = s.width || 1280;
    const h = s.height || 800;
    const cs = 512;
    const minCx = Math.floor((-tx / zoom - 256) / cs);
    const maxCx = Math.floor(((w - tx) / zoom + 256) / cs);
    const minCy = Math.floor((-ty / zoom - 256) / cs);
    const maxCy = Math.floor(((h - ty) / zoom + 256) / cs);
    return `${minCx},${maxCx},${minCy},${maxCy}`;
  });

  const chunkManagerRef = useRef<ChunkManager | null>(null);
  const tileCacheRef = useRef(new ChunkTileCache(160));
  const draggingNodeIdsRef = useRef<Set<string>>(new Set());

  const allTemplates = useMemo(
    () => [...customTemplates, ...BUILTIN_TEMPLATES],
    [customTemplates]
  );

  const effectiveNodes = useMemo(() => resolveEffectiveNodes(base, overlay), [base, overlay]);
  const effectiveAnnotations = useMemo(
    () => resolveEffectiveAnnotations(base, overlay),
    [base, overlay]
  );
  const effectiveNodesRef = useRef(effectiveNodes);
  effectiveNodesRef.current = effectiveNodes;
  const effectiveAnnotationsRef = useRef(effectiveAnnotations);
  effectiveAnnotationsRef.current = effectiveAnnotations;

  if (!chunkManagerRef.current) {
    const cm = new ChunkManager(512);
    cm.rebuild(effectiveNodes, effectiveAnnotations);
    chunkManagerRef.current = cm;
  }

  // 迟滞区间 LOD 监听
  useEffect(() => {
    const syncLod = (zoom: number) => {
      setLod((prev) => {
        if (prev !== 'macro' && zoom < 0.32) return 'macro';
        if (prev === 'macro' && zoom > 0.38) return zoom < 0.72 ? 'meso' : 'micro';
        if (prev !== 'macro') return zoom < 0.72 ? 'meso' : 'micro';
        return prev;
      });
    };
    syncLod(rfStore.getState().transform[2]);
    return rfStore.subscribe((state) => {
      syncLod(state.transform[2]);
    });
  }, [rfStore]);

  // 仅在底座更新、注释变更、切换 LOD、切换注释编辑态或拖拽松手时重建 Chunk 索引与瓦片缓存
  const isFirstEffectRef = useRef(true);
  useEffect(() => {
    if (isFirstEffectRef.current) {
      isFirstEffectRef.current = false;
      return;
    }
    if (draggingNodeIdsRef.current.size > 0) return;
    chunkManagerRef.current?.rebuild(effectiveNodesRef.current, effectiveAnnotationsRef.current);
    tileCacheRef.current.clear();
    setRenderVersion((v) => v + 1);
  }, [base.version, effectiveAnnotations, lod, annotationEditMode, chunkSyncTick]);

  // 启动时从 IndexedDB 恢复本地叠加层、自定义模板与已发布底座
  useEffect(() => {
    let active = true;
    void (async () => {
      const [savedOverlay, savedTpls] = await Promise.all([
        loadLocalOverlay(),
        loadCustomTemplates(),
      ]);
      if (!active) return;
      overlayHydratedRef.current = true;
      setOverlay(savedOverlay);
      setCustomTemplates(savedTpls);
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
        // 离线或无后端时继续使用种子蓝图
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!overlayHydratedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveLocalOverlay(overlay);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [overlay]);

  // 实例化任意模板到指定世界坐标
  const instantiateTemplateAt = useCallback((tpl: BlueprintTemplate, worldX: number, worldY: number) => {
    const x = Math.round(worldX);
    const y = Math.round(worldY);
    if (tpl.kind === 'annotation' && tpl.annotationPreset) {
      const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      setBase((prev) => ({
        ...prev,
        version: prev.version + 1,
        annotations: {
          ...prev.annotations,
          [id]: {
            ...tpl.annotationPreset!,
            id,
            x,
            y,
            rev: 1,
            cid: SELF_CID,
          },
        },
      }));
      setStatusLog(`已在 (${x}, ${y}) 放入「${tpl.name}」`);
      return;
    }

    if (tpl.kind === 'node' && tpl.nodePreset) {
      const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      const newNode: BlueprintNode = {
        ...tpl.nodePreset,
        id,
        x,
        y,
        defaultVars: { ...tpl.nodePreset.defaultVars },
        buttons: tpl.nodePreset.buttons ? tpl.nodePreset.buttons.map((b) => ({ ...b })) : [],
        rev: 1,
        cid: SELF_CID,
      };
      setBase((prev) => ({
        ...prev,
        version: prev.version + 1,
        nodes: { ...prev.nodes, [id]: newNode },
      }));
      setStatusLog(`已放入「${tpl.name}」，可直接拖动或改字`);
    }
  }, []);

  const handleCreateTemplateCenter = useCallback(
    (tpl: BlueprintTemplate) => {
      const [tx, ty, zoom] = rfStore.getState().transform;
      const offset = Math.round((Math.random() - 0.5) * 60);
      const centerX = (window.innerWidth * 0.55 - tx) / zoom - 140 + offset;
      const centerY = (window.innerHeight * 0.5 - ty) / zoom - 80 + offset;
      instantiateTemplateAt(tpl, centerX, centerY);
    },
    [rfStore, instantiateTemplateAt]
  );

  // 画布接收从左侧模板库拖出的控件（所见即所得 Drop！）
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const tplId =
        e.dataTransfer.getData(TEMPLATE_DRAG_MIME) || e.dataTransfer.getData('text/plain');
      if (!tplId) return;
      const tpl = allTemplates.find((t) => t.id === tplId);
      if (!tpl) return;

      const worldPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const halfW = tpl.nodePreset ? tpl.nodePreset.width * 0.5 : 140;
      const halfH = tpl.nodePreset ? 24 : 16;
      instantiateTemplateAt(tpl, worldPos.x - halfW, worldPos.y - halfH);
    },
    [allTemplates, rf, instantiateTemplateAt]
  );

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
        setOverlay((prev) => {
          const nextAnnOverrides = { ...(prev.annotationOverrides ?? {}) };
          for (const op of res.annotationOps) {
            nextAnnOverrides[op.id] = {
              ...(nextAnnOverrides[op.id] ?? {}),
              ...op.patch,
            };
          }
          return {
            ...prev,
            runtimeVars: {
              ...prev.runtimeVars,
              [nodeId]: res.updatedVars,
            },
            annotationOverrides: nextAnnOverrides,
          };
        });
        if (res.annotationOps.length > 0) {
          setChunkSyncTick((t) => t + 1);
        }
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


  const buildPeerSnapshots = useCallback(
    (sourceNodes: Record<string, EffectiveBlueprintNode>): Record<string, PeerWidgetSnapshot> => {
      const peers: Record<string, PeerWidgetSnapshot> = {};
      for (const n of Object.values(sourceNodes)) {
        peers[n.id] = {
          id: n.id,
          title: n.title,
          label: n.title,
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
          color: n.color,
          vars: { ...n.effectiveVars },
        };
      }
      return peers;
    },
    []
  );

  // 统一脚本调度器：支持 render / click / submit / message，递归处理 widgets.create/connect/remove 与 emit/broadcast
  const executeUnifiedWidgetScript = useCallback(
    async (
      nodeId: string,
      trigger: ScriptTriggerEvent,
      overrideVars?: Record<string, unknown>,
      depth = 0
    ) => {
      if (depth > 4) return;
      const entity = effectiveNodesRef.current[nodeId];
      if (!entity || !entity.script) return;

      const peers = buildPeerSnapshots(effectiveNodesRef.current);
      const selfEntity = peers[nodeId];
      const inputVars = overrideVars ?? entity.effectiveVars;
      const res = await runInIsolatedWorker(entity.script, inputVars, {
        selfEntity,
        peers,
        trigger,
      });

      if (!res.ok) {
        setStatusLog(`脚本错误 (${entity.title})：${res.error}`);
        return;
      }

      // 1) 更新自身 runtimeVars 与画板背景注释覆盖
      setOverlay((prev) => {
        const nextAnnOverrides = { ...(prev.annotationOverrides ?? {}) };
        for (const op of res.annotationOps) {
          nextAnnOverrides[op.id] = { ...(nextAnnOverrides[op.id] ?? {}), ...op.patch };
        }
        return {
          ...prev,
          runtimeVars: {
            ...prev.runtimeVars,
            [nodeId]: res.updatedVars,
          },
          annotationOverrides: nextAnnOverrides,
        };
      });

      // 2) 处理 widgets.create / connect / remove 指令
      const newlyCreatedScripts: Array<{ id: string; vars: Record<string, unknown>; script: string }> = [];
      if (res.widgetOps.length > 0) {
        setBase((prev) => {
          const nextNodes = { ...prev.nodes };
          const nextEdges = { ...prev.edges };
          for (const op of res.widgetOps) {
            if (op.op === 'create') {
              nextNodes[op.id] = {
                id: op.id,
                x: op.x,
                y: op.y,
                width: op.width,
                height: op.height,
                title: op.title,
                body: op.body || '',
                category: op.category || '子控件',
                color: op.color,
                script: op.script,
                defaultVars: op.vars || {},
                rev: 1,
                cid: SELF_CID,
              };
              if (op.script) {
                newlyCreatedScripts.push({ id: op.id, vars: op.vars || {}, script: op.script });
              }
              if (op.connect) {
                const eid = `edge-${nodeId}-${op.id}-${Date.now()}`;
                nextEdges[eid] = {
                  id: eid,
                  source: nodeId,
                  target: op.id,
                  sourceHandle: 'out-1',
                  targetHandle: 'in-1',
                  label: typeof op.connect === 'string' ? op.connect : undefined,
                  color: op.color,
                  rev: 1,
                  cid: SELF_CID,
                };
              }
            } else if (op.op === 'connect') {
              const eid = `edge-${op.fromId}-${op.toId}-${Date.now()}`;
              nextEdges[eid] = {
                id: eid,
                source: op.fromId,
                target: op.toId,
                sourceHandle: 'out-1',
                targetHandle: 'in-1',
                label: op.label,
                color: '#2563EB',
                rev: 1,
                cid: SELF_CID,
              };
            } else if (op.op === 'remove') {
              delete nextNodes[op.id];
              for (const [eid, e] of Object.entries(nextEdges)) {
                if (e.source === op.id || e.target === op.id) delete nextEdges[eid];
              }
            }
          }
          return { ...prev, version: prev.version + 1, nodes: nextNodes, edges: nextEdges };
        });
      }

      if (res.annotationOps.length > 0 || res.widgetOps.length > 0) {
        setChunkSyncTick((t) => t + 1);
      }

      // 新建的带脚本子控件立刻跑一次 render 产出它们的 vars.contents
      for (const child of newlyCreatedScripts) {
        const childRes = await runInIsolatedWorker(child.script, child.vars, {
          selfEntity: {
            id: child.id,
            title: child.id,
            label: child.id,
            x: 0,
            y: 0,
            width: 320,
            height: 175,
            color: '#059669',
            vars: child.vars,
          },
          peers,
          trigger: { kind: 'render' },
        });
        if (childRes.ok) {
          setOverlay((prev) => ({
            ...prev,
            runtimeVars: { ...prev.runtimeVars, [child.id]: childRes.updatedVars },
          }));
        }
      }

      // 3) 处理跨控件 emit / broadcast 事件投递
      for (const em of res.emitOps) {
        const targets =
          em.targetId === '*'
            ? Object.values(effectiveNodesRef.current)
                .filter((n) => n.id !== nodeId && Boolean(n.script))
                .map((n) => n.id)
            : [em.targetId];
        for (const tid of targets) {
          await executeUnifiedWidgetScript(
            tid,
            {
              kind: 'message',
              event: em.event,
              payload: em.payload,
              fromId: nodeId,
              fromTitle: entity.title,
            },
            undefined,
            depth + 1
          );
        }
      }
    },
    [buildPeerSnapshots]
  );

  // 初始化所有带 script 的控件，首次自动渲染其 vars.contents
  const renderedScriptsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const node of Object.values(effectiveNodes)) {
      if (node.script && !Array.isArray(node.effectiveVars?.contents) && !renderedScriptsRef.current.has(node.id)) {
        renderedScriptsRef.current.add(node.id);
        void executeUnifiedWidgetScript(node.id, { kind: 'render' });
      }
    }
  }, [effectiveNodes, executeUnifiedWidgetScript]);

  const handleRunScriptClick = useCallback(
    async (nodeId: string, buttonId: string) => {
      const key = `${nodeId}:script:${buttonId}`;
      setBusyButtonKey(key);
      try {
        await executeUnifiedWidgetScript(nodeId, { kind: 'click', buttonId });
      } finally {
        setBusyButtonKey(null);
      }
    },
    [executeUnifiedWidgetScript]
  );

  const handleScriptInputChange = useCallback((nodeId: string, bindKey: string, value: string) => {
    setOverlay((prev) => ({
      ...prev,
      runtimeVars: {
        ...prev.runtimeVars,
        [nodeId]: {
          ...(prev.runtimeVars[nodeId] ?? effectiveNodesRef.current[nodeId]?.effectiveVars ?? {}),
          [bindKey]: value,
        },
      },
    }));
  }, []);

  const handleScriptInputSubmit = useCallback(
    async (nodeId: string, inputId: string, value: string) => {
      await executeUnifiedWidgetScript(nodeId, { kind: 'submit', inputId, value });
    },
    [executeUnifiedWidgetScript]
  );

  const handleToggleLock = useCallback((nodeId: string) => {
    const cur = effectiveNodesRef.current[nodeId];
    if (!cur) return;
    const nextLocked = !cur.locked;
    setOverlay((prev) => ({
      ...prev,
      nodePatches: {
        ...prev.nodePatches,
        [nodeId]: { ...(prev.nodePatches[nodeId] ?? {}), locked: nextLocked },
      },
    }));
    setStatusLog(nextLocked ? `已锁定「${cur.title}」（防误拖，按钮与输入框仍可操作）` : `已解锁「${cur.title}」`);
  }, []);

  const handleRunScriptRefresh = useCallback(
    (nodeId: string) => {
      void executeUnifiedWidgetScript(nodeId, { kind: 'render' });
      setStatusLog('已重新执行控件统一脚本并刷新 UI');
    },
    [executeUnifiedWidgetScript]
  );

  const handleResetNodeLocal = useCallback((nodeId: string) => {
    setOverlay((prev) => {
      const nextRuntime = { ...prev.runtimeVars };
      const nextPatches = { ...prev.nodePatches };
      delete nextRuntime[nodeId];
      delete nextPatches[nodeId];
      return { ...prev, runtimeVars: nextRuntime, nodePatches: nextPatches };
    });
    renderedScriptsRef.current.delete(nodeId);
    setChunkSyncTick((t) => t + 1);
    setStatusLog('已将该节点重置为后端权威默认值');
  }, []);

  const handlePatchNode = useCallback((nodeId: string, patch: Partial<EffectiveBlueprintNode>) => {
    setOverlay((prev) => ({
      ...prev,
      nodePatches: {
        ...prev.nodePatches,
        [nodeId]: {
          ...(prev.nodePatches[nodeId] ?? {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.category !== undefined ? { category: patch.category } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.width !== undefined ? { width: patch.width } : {}),
          ...(patch.height !== undefined ? { height: patch.height } : {}),
          ...(patch.buttons !== undefined ? { buttons: patch.buttons } : {}),
          ...(patch.script !== undefined ? { script: patch.script } : {}),
          ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
          ...(patch.inputPorts !== undefined ? { inputPorts: patch.inputPorts } : {}),
          ...(patch.outputPorts !== undefined ? { outputPorts: patch.outputPorts } : {}),
        },
      },
    }));
  }, []);

  const handleEditTitle = useCallback(
    (nodeId: string, nextTitle: string) => handlePatchNode(nodeId, { title: nextTitle }),
    [handlePatchNode]
  );

  const handleEditBody = useCallback(
    (nodeId: string, nextBody: string) => handlePatchNode(nodeId, { body: nextBody }),
    [handlePatchNode]
  );

  const handleResizeNode = useCallback(
    (nodeId: string, width: number, height: number) => {
      handlePatchNode(nodeId, { width, height });
      setChunkSyncTick((t) => t + 1);
    },
    [handlePatchNode]
  );

  const handleUpdateDefaultVar = useCallback((nodeId: string, key: string, rawVal: string) => {
    let parsed: unknown = rawVal;
    if (rawVal === 'true') parsed = true;
    else if (rawVal === 'false') parsed = false;
    else if (rawVal !== '' && Number.isFinite(Number(rawVal))) parsed = Number(rawVal);

    setBase((prev) => {
      const cur = prev.nodes[nodeId];
      if (!cur) return prev;
      return {
        ...prev,
        version: prev.version + 1,
        nodes: {
          ...prev.nodes,
          [nodeId]: {
            ...cur,
            defaultVars: { ...cur.defaultVars, [key]: parsed },
            rev: cur.rev + 1,
            cid: SELF_CID,
          },
        },
      };
    });
  }, []);

  const handleDeleteDefaultVar = useCallback((nodeId: string, key: string) => {
    setBase((prev) => {
      const cur = prev.nodes[nodeId];
      if (!cur) return prev;
      const nextVars = { ...cur.defaultVars };
      delete nextVars[key];
      return {
        ...prev,
        version: prev.version + 1,
        nodes: {
          ...prev.nodes,
          [nodeId]: { ...cur, defaultVars: nextVars, rev: cur.rev + 1, cid: SELF_CID },
        },
      };
    });
  }, []);

  const handleDuplicateNode = useCallback((nodeId: string) => {
    const src = effectiveNodesRef.current[nodeId];
    if (!src) return;
    const newId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const copy: BlueprintNode = {
      id: newId,
      x: Math.round(src.x + 36),
      y: Math.round(src.y + 36),
      width: src.width,
      height: src.height,
      title: `${src.title} (副本)`,
      body: src.body,
      category: src.category,
      color: src.color,
      defaultVars: { ...src.effectiveVars },
      buttons: src.buttons ? src.buttons.map((b) => ({ ...b })) : [],
      rev: 1,
      cid: SELF_CID,
    };
    setBase((prev) => ({
      ...prev,
      version: prev.version + 1,
      nodes: { ...prev.nodes, [newId]: copy },
    }));
    setInspectingNodeId(newId);
    setStatusLog(`已复制控件「${src.title}」`);
  }, []);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setBase((prev) => {
      const nextNodes = { ...prev.nodes };
      delete nextNodes[nodeId];
      const nextEdges: typeof prev.edges = {};
      for (const [eid, edge] of Object.entries(prev.edges)) {
        if (edge.source !== nodeId && edge.target !== nodeId) {
          nextEdges[eid] = edge;
        }
      }
      return { ...prev, version: prev.version + 1, nodes: nextNodes, edges: nextEdges };
    });
    setOverlay((prev) => {
      const nextRuntime = { ...prev.runtimeVars };
      const nextPatches = { ...prev.nodePatches };
      delete nextRuntime[nodeId];
      delete nextPatches[nodeId];
      return { ...prev, runtimeVars: nextRuntime, nodePatches: nextPatches };
    });
    setInspectingNodeId((cur) => (cur === nodeId ? null : cur));
    setStatusLog('已删除控件及其关联连线');
  }, []);

  const handleSaveAsTemplate = useCallback((node: EffectiveBlueprintNode) => {
    const name = window.prompt('为这个自定义模板起个名字：', node.title);
    if (!name) return;
    const tpl = nodeToCustomTemplate(node, name);
    setCustomTemplates((prev) => {
      const next = [tpl, ...prev];
      void saveCustomTemplates(next);
      return next;
    });
    setTemplateDrawerOpen(true);
    setStatusLog(`已保存到「我的模板」并写入 IndexedDB：${tpl.name}`);
  }, []);

  const handleDeleteCustomTemplate = useCallback((tplId: string) => {
    setCustomTemplates((prev) => {
      const next = prev.filter((t) => t.id !== tplId);
      void saveCustomTemplates(next);
      return next;
    });
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

  // 关键防闪烁同步：将可见 Chunk 的节点增量合入 rfNodes，严格保留每个已有节点的 measured / dragging / selected！
  useEffect(() => {
    if (lod === 'macro' || !chunkManagerRef.current) {
      setRfNodes((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const [minCx, maxCx, minCy, maxCy] = viewportBucketKey.split(',').map(Number);
    const cs = 512;
    const worldBounds = {
      minX: minCx * cs,
      minY: minCy * cs,
      maxX: (maxCx + 1) * cs,
      maxY: (maxCy + 1) * cs,
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

    setRfNodes((prev) => {
      const prevMap = new Map<string, Node>();
      for (const n of prev) prevMap.set(n.id, n);

      const next: Node[] = [];

      if (annotationEditMode) {
        for (const aid of visibleAnnIds) {
          const ann = effectiveAnnotations[aid];
          if (!ann) continue;
          const rfId = `ann-node:${ann.id}`;
          const existing = prevMap.get(rfId);
          const isDragging = existing?.dragging || draggingNodeIdsRef.current.has(rfId);
          next.push({
            ...(existing ?? {}),
            id: rfId,
            type: 'annotation',
            position: isDragging && existing ? existing.position : { x: ann.x, y: ann.y },
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
        const existing = prevMap.get(entity.id);
        const isDragging = existing?.dragging || draggingNodeIdsRef.current.has(entity.id);
        next.push({
          ...(existing ?? {}),
          id: entity.id,
          type: 'widget',
          draggable: !entity.locked,
          // 拖动过程中绝对保留 React Flow 自己的 position 与 measured，彻底杜绝闪烁消失！
          position: isDragging && existing ? existing.position : { x: entity.x, y: entity.y },
          zIndex: 10,
          data: {
            entity,
            onRunButton: handleRunButton,
            onRunScriptClick: handleRunScriptClick,
            onScriptInputChange: handleScriptInputChange,
            onScriptInputSubmit: handleScriptInputSubmit,
            onToggleLock: handleToggleLock,
            onResetLocal: handleResetNodeLocal,
            onEditTitle: handleEditTitle,
            onEditBody: handleEditBody,
            onResizeNode: handleResizeNode,
            onOpenInspector: setInspectingNodeId,
            onDuplicateNode: handleDuplicateNode,
            onDeleteNode: handleDeleteNode,
            busyButtonKey,
          } satisfies WidgetNodeData,
        });
      }

      return next;
    });
  }, [
    lod,
    viewportBucketKey,
    effectiveNodes,
    effectiveAnnotations,
    annotationEditMode,
    handleRunButton,
    handleRunScriptClick,
    handleScriptInputChange,
    handleScriptInputSubmit,
    handleToggleLock,
    handleResetNodeLocal,
    handleEditTitle,
    handleEditBody,
    handleResizeNode,
    handleDuplicateNode,
    handleDeleteNode,
    handleUpdateAnnotation,
    handleDeleteAnnotation,
    busyButtonKey,
    renderVersion,
  ]);

  const rfEdges: Edge[] = useMemo(() => {
    if (lod === 'macro') return [];
    return Object.values(base.edges).map((e) => {
      const stroke = e.color || '#64748B';
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        label: e.label,
        animated: Boolean(e.dashed),
        style: { stroke, strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color: stroke,
        },
      };
    });
  }, [lod, base.edges]);

  // 关键修复：onNodesChange 直接交给 applyNodeChanges 处理拖动/测量/选中，
  // 拖动过程中不触碰 overlay/base，只在松手（dragging === false）时一次性落盘，0 闪烁！
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((prev) => {
      const updated = applyNodeChanges(changes, prev);

      const widgetFinals: Array<{ id: string; x: number; y: number }> = [];
      const annFinals: Array<{ id: string; x: number; y: number }> = [];

      for (const ch of changes) {
        if (ch.type === 'position') {
          if (ch.dragging === true) {
            draggingNodeIdsRef.current.add(ch.id);
          } else if (ch.dragging === false) {
            draggingNodeIdsRef.current.delete(ch.id);
            const node = updated.find((n) => n.id === ch.id);
            const pos = ch.position ?? node?.position;
            if (pos) {
              const x = Math.round(pos.x);
              const y = Math.round(pos.y);
              if (ch.id.startsWith('ann-node:')) {
                annFinals.push({ id: ch.id.slice('ann-node:'.length), x, y });
              } else {
                widgetFinals.push({ id: ch.id, x, y });
              }
            }
          }
        }
      }

      if (widgetFinals.length > 0) {
        queueMicrotask(() => {
          setOverlay((o) => {
            const nextPatches = { ...o.nodePatches };
            for (const u of widgetFinals) {
              nextPatches[u.id] = { ...(nextPatches[u.id] ?? {}), x: u.x, y: u.y };
            }
            return { ...o, nodePatches: nextPatches };
          });
          setChunkSyncTick((t) => t + 1);
        });
      }

      if (annFinals.length > 0) {
        queueMicrotask(() => {
          setBase((b) => {
            const nextAnns = { ...b.annotations };
            for (const u of annFinals) {
              const cur = nextAnns[u.id];
              if (cur) nextAnns[u.id] = { ...cur, x: u.x, y: u.y };
            }
            return { ...b, annotations: nextAnns };
          });
          setChunkSyncTick((t) => t + 1);
        });
      }

      return updated;
    });
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    const id = `edge-${conn.source}-${conn.target}-${Date.now()}`;
    setBase((prev) => ({
      ...prev,
      version: prev.version + 1,
      edges: {
        ...prev.edges,
        [id]: {
          id,
          source: conn.source!,
          target: conn.target!,
          sourceHandle: conn.sourceHandle ?? undefined,
          targetHandle: conn.targetHandle ?? undefined,
          color: '#2563EB',
          rev: 1,
          cid: SELF_CID,
        },
      },
    }));
    setStatusLog('已建立节点连线（选中连线按 Delete 可删除）');
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length === 0) return;
    setBase((prev) => {
      const nextEdges = { ...prev.edges };
      for (const id of removed) delete nextEdges[id];
      return { ...prev, version: prev.version + 1, edges: nextEdges };
    });
    setStatusLog('已删除连线');
  }, []);

  const handleSaveToBackend = async () => {
    const key = saveKeyInput.trim();
    if (!key) {
      setSaveKeyError('请输入保存密钥（无密钥仅可使用控件内置 API 访问后端）');
      return;
    }
    setIsSavingBase(true);
    setSaveKeyError(null);
    const merged = applyOverlayToBase(base, overlay, SELF_CID);
    try {
      const res = await fetch('/api/blueprint/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Blueprint-Save-Key': key,
        },
        body: JSON.stringify({ blueprint: merged }),
      });
      const json = (await res.json()) as { ok: boolean; serverRevision?: number; error?: string };
      if (!res.ok || !json.ok) {
        setSaveKeyError(json.error || `保存被拒绝 (HTTP ${res.status})`);
        setStatusLog(`保存失败：${json.error || res.status}`);
        return;
      }
      setBase(merged);
      setOverlay((prev) => ({ ...prev, nodePatches: {}, annotationOverrides: {} }));
      setChunkSyncTick((t) => t + 1);
      setSaveModalOpen(false);
      setStatusLog(`已通过密钥校验并保存到后端 (rev #${json.serverRevision})`);
    } catch {
      setSaveKeyError('无法连接到后端保存接口，当前修改仍安全保留在本地 IndexedDB');
    } finally {
      setIsSavingBase(false);
    }
  };

  const handleSpawnStress = () => {
    setBase((prev) => spawnStressChunks(prev));
    setStatusLog('已生成 360+ 跨区压测节点！缩远至 < 32% 可体验全景瓦片与清晰大字标题');
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 80);
  };

  const inspectingNode = inspectingNodeId ? effectiveNodes[inspectingNodeId] ?? null : null;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 顶栏精简控制台 */}
      <div className="pointer-events-auto absolute top-3 left-3 right-3 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/92 px-3 py-2 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTemplateDrawerOpen((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold text-white ${
              templateDrawerOpen ? 'bg-blue-700 hover:bg-blue-800' : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            模板库 ({allTemplates.length})
          </button>

          <button
            type="button"
            onClick={() => handleCreateTemplateCenter(BUILTIN_TEMPLATES[9])}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
            快速新建控件
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
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              annotationEditMode
                ? 'border-amber-500 bg-amber-50 text-amber-900'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {annotationEditMode ? '注释层：可拖动编辑' : '注释层：已锁定穿透'}
          </button>

          <ZoomBadge lod={lod} />
          <span className="font-mono text-[11px] text-slate-500">
            总节点 {Object.keys(effectiveNodes).length} · DOM {rfNodes.length} · 瓦片 {tileCacheRef.current.size}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowChunkGrid((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            <Layers className="h-3.5 w-3.5" />
            {showChunkGrid ? '隐藏网格' : '显示网格'}
          </button>

          <button
            type="button"
            onClick={handleSpawnStress}
            className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100"
          >
            <Zap className="h-3.5 w-3.5" />
            压测大地图
          </button>

          <button
            type="button"
            onClick={() => {
              renderedScriptsRef.current.clear();
              setOverlay(createEmptyOverlay());
              setChunkSyncTick((t) => t + 1);
              setStatusLog('已清空所有个人本地叠加层，恢复后端权威默认值');
            }}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置本地
          </button>

          <button
            type="button"
            onClick={() => {
              setSaveKeyError(null);
              setSaveModalOpen(true);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
          >
            <Save className="h-3.5 w-3.5" />
            保存（需 Key）
          </button>
        </div>
      </div>

      {/* 左侧所见即所得模板库抽屉（直接拖入画布） */}
      <TemplateDrawer
        open={templateDrawerOpen}
        templates={allTemplates}
        onClose={() => setTemplateDrawerOpen(false)}
        onCreateCenter={handleCreateTemplateCenter}
        onDeleteCustomTemplate={handleDeleteCustomTemplate}
      />

      {/* 右侧控件属性与脚本编辑器 */}
      <NodeInspectorPanel
        node={inspectingNode}
        onClose={() => setInspectingNodeId(null)}
        onPatchNode={handlePatchNode}
        onRunScriptRefresh={handleRunScriptRefresh}
        onUpdateDefaultVar={handleUpdateDefaultVar}
        onDeleteDefaultVar={handleDeleteDefaultVar}
        onDuplicateNode={handleDuplicateNode}
        onDeleteNode={handleDeleteNode}
        onResetLocal={handleResetNodeLocal}
        onSaveAsTemplate={handleSaveAsTemplate}
      />

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
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeDoubleClick={(_ev, edge) => {
          const cur = base.edges[edge.id];
          if (!cur) return;
          const nextLabel = window.prompt('修改连线标签文字（留空清除）：', cur.label ?? '');
          if (nextLabel === null) return;
          setBase((prev) => ({
            ...prev,
            version: prev.version + 1,
            edges: {
              ...prev.edges,
              [edge.id]: { ...cur, label: nextLabel.trim() || undefined, rev: cur.rev + 1, cid: SELF_CID },
            },
          }));
        }}
        onPaneClick={() => setInspectingNodeId(null)}
        minZoom={0.12}
        maxZoom={2.5}
        defaultViewport={{ x: 360, y: 90, zoom: 0.88 }}
        style={{ background: 'transparent' }}
      >
        <ChunkUnderlayCanvas
          chunkManager={chunkManagerRef.current}
          tileCache={tileCacheRef.current}
          nodes={effectiveNodes}
          annotations={effectiveAnnotations}
          lod={lod}
          showChunkGrid={showChunkGrid}
          annotationEditMode={annotationEditMode}
          renderVersion={renderVersion}
        />
        <Controls position="bottom-right" />
      </ReactFlow>
      {/* 保存密钥验证弹窗 */}
      {saveModalOpen && (
        <div
          className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]"
          onClick={() => setSaveModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-slate-900">
              <KeyRound className="h-5 w-5 text-blue-700" />
              <h3 className="text-sm font-bold">保存到后端（需要管理员密钥）</h3>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              将你的本地画布修改保存为后端公共版本需要校验 <code className="rounded bg-slate-100 px-1 font-mono">X-Blueprint-Save-Key</code>。没有密钥的访客只能通过控件内预设好的 API 按钮访问后端，个人修改仅保存在本地 IndexedDB。
            </p>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-semibold text-slate-700">保存密钥 (Save Key)</label>
              <input
                type="password"
                autoFocus
                value={saveKeyInput}
                onChange={(e) => setSaveKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveToBackend();
                }}
                placeholder="输入 BLUEPRINT_SAVE_KEY（静态演示密钥：atlas-demo-key）"
                className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-blue-600"
              />
            </div>

            {saveKeyError && (
              <div className="mt-2.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {saveKeyError}
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setSaveModalOpen(false)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isSavingBase}
                onClick={() => void handleSaveToBackend()}
                className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {isSavingBase ? '校验并保存中…' : '校验 Key 并保存'}
              </button>
            </div>
          </div>
        </div>
      )}
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
