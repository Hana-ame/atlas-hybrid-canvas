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
  Download,
  KeyRound,
  LayoutGrid,
  Layers,
  Link2,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Undo2,
  Upload,
  Users,
  Zap,
} from 'lucide-react';
import { AnnotationNode, type AnnotationNodeData } from './canvas/AnnotationNode';
import { ChunkUnderlayCanvas } from './canvas/ChunkUnderlayCanvas';
import { WidgetNode, type WidgetNodeData } from './canvas/WidgetNode';
import { NodeInspectorPanel, type ScriptConsoleEntry } from './components/NodeInspectorPanel';
import { SearchJumpModal } from './components/SearchJumpModal';
import {
  ScriptTrustModal,
  auditBlueprintScripts,
  type ScriptAuditEntry,
} from './components/ScriptTrustModal';
import {
  CollaborativeRoomClient,
  mergeRemoteBlueprintCRDT,
  type RoomStatus,
} from './core/roomClient';
import { TEMPLATE_DRAG_MIME, TemplateDrawer } from './components/TemplateDrawer';
import { ChunkManager } from './core/chunkManager';
import { beats, computeRecordDiff } from './core/crdt';
import { findNonOverlappingPosition, type RectBox } from './core/placement';
import { ChunkTileCache } from './core/chunkTileCache';
import { computeThreeRingBounds, filterVisibleEdges, isBoxIntersecting } from './core/viewportCulling';
import {
  applyOverlayToBase,
  clearConflictingRuntimeVars,
  createEmptyOverlay,
  loadLocalOverlay,
  resolveEffectiveAnnotations,
  resolveEffectiveNodes,
} from './core/layeredStore';
import {
  runInIsolatedWorker,
  validateDagConnection,
  type EdgeSnapshot,
  type PeerWidgetSnapshot,
  type ScriptTriggerEvent,
} from './core/scriptSandbox';
import { useBlueprintHistory } from './hooks/useBlueprintHistory';
import { useOverlaySync } from './hooks/useOverlaySync';
import { proxyHeaders } from './core/apiClient';
import { defaultRoomWsUrl, hasBackend } from './core/runtimeConfig';
import { createSeedBlueprint, spawnStressChunks } from './core/seedBlueprint';
import {
  BUILTIN_TEMPLATES,
  loadCustomTemplates,
  nodeToCustomTemplate,
  saveCustomTemplates,
} from './core/widgetTemplates';
import type {
  BaseBlueprint,
  BlueprintEdge,
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

function toFiniteNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

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
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 768 : true));
  const [inspectingNodeId, setInspectingNodeId] = useState<string | null>(null);
  const [busyButtonKey, setBusyButtonKey] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveKeyInput, setSaveKeyInput] = useState('');
  const [saveKeyError, setSaveKeyError] = useState<string | null>(null);
  const [isSavingBase, setIsSavingBase] = useState(false);

  // 1) IndexedDB 恢复就绪标记（驱动 useOverlaySync 防抖与跨页签同步）
  const [overlayHydrated, setOverlayHydrated] = useState(false);

  // 2) Ctrl+K 全局搜索与坐标跳转弹窗
  const [searchOpen, setSearchOpen] = useState(false);

  // 3) 外部 JSON 导入与脚本信任锁
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [untrustedScriptKeys, setUntrustedScriptKeys] = useState<Set<string>>(() => new Set());
  const untrustedScriptKeysRef = useRef<Set<string>>(untrustedScriptKeys);
  untrustedScriptKeysRef.current = untrustedScriptKeys;
  const [trustModalState, setTrustModalState] = useState<{
    open: boolean;
    sourceLabel: string;
    entries: ScriptAuditEntry[];
  }>({ open: false, sourceLabel: '', entries: [] });

  // 4) 多人实时协同房间（WebSocket + CRDT）
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [roomWsUrl, setRoomWsUrl] = useState(() => defaultRoomWsUrl());
  const [roomName, setRoomName] = useState('atlas-main');
  const roomNameRef = useRef(roomName);
  roomNameRef.current = roomName;
  const maxSyncedMetaRef = useRef<Map<string, { id: string; rev: number; cid: string }>>(new Map());
  const prevSyncedBaseRef = useRef<BaseBlueprint | null>(null);
  const [roomStatus, setRoomStatus] = useState<RoomStatus>('disconnected');
  const roomClientRef = useRef<CollaborativeRoomClient | null>(null);
  const [statusLog, setStatusLog] = useState<string>('');
  const [scriptLogsByNode, setScriptLogsByNode] = useState<Record<string, ScriptConsoleEntry[]>>({});

  const appendNodeLogs = useCallback(
    (nodeId: string, triggerLabel: string, entries: Array<{ level: 'log' | 'error' | 'info'; message: string }>) => {
      if (entries.length === 0) return;
      const now = new Date();
      const ts = now.toTimeString().slice(0, 8);
      const stamped: ScriptConsoleEntry[] = entries.map((e, idx) => ({
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        ts,
        level: e.level,
        trigger: triggerLabel,
        message: e.message,
      }));
      setScriptLogsByNode((prev) => {
        const cur = prev[nodeId] ?? [];
        const merged = [...cur, ...stamped].slice(-50);
        return { ...prev, [nodeId]: merged };
      });
    },
    []
  );

  const handleClearScriptLogs = useCallback((nodeId: string) => {
    setScriptLogsByNode((prev) => {
      if (!prev[nodeId]) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  }, []);
  useEffect(() => {
    if (!statusLog) return;
    const t = window.setTimeout(() => setStatusLog(''), 3500);
    return () => window.clearTimeout(t);
  }, [statusLog]);
  const [renderVersion, setRenderVersion] = useState(0);
  const [chunkSyncTick, setChunkSyncTick] = useState(0);

  // 关键修复：使用 React Flow 原生受控 nodes 状态 + applyNodeChanges，
  // 彻底保留 React Flow v12 内部的 measured / dragging / selected 状态，消除拖动控件时高频消失再出现！
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const rfNodesRef = useRef<Node[]>(rfNodes);
  rfNodesRef.current = rfNodes;

  const [lod, setLod] = useState<LODLevel>('micro');
  const rf = useReactFlow();
  const rfStore = useStoreApi();

  // 粗粒度视口桶 Key：按 256px 步进量化视口范围，平移每像素绝不触发 App 重渲染
  const viewportBucketKey = useStore((s) => {
    const [tx, ty, zoom] = s.transform;
    const w = s.width || 1280;
    const h = s.height || 800;
    const step = 256;
    const minX = Math.floor((-tx / zoom) / step) * step;
    const maxX = Math.ceil(((w - tx) / zoom) / step) * step;
    const minY = Math.floor((-ty / zoom) / step) * step;
    const maxY = Math.ceil(((h - ty) / zoom) / step) * step;
    return `${minX},${maxX},${minY},${maxY}`;
  });
  const prevViewportCenterRef = useRef<{ cx: number; cy: number } | null>(null);
  const threeRingBounds = useMemo(() => {
    const [minX, maxX, minY, maxY] = viewportBucketKey.split(',').map(Number);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    let dirX = 0;
    let dirY = 0;
    if (prevViewportCenterRef.current) {
      const dx = cx - prevViewportCenterRef.current.cx;
      const dy = cy - prevViewportCenterRef.current.cy;
      if (Math.abs(dx) >= 128) dirX = dx > 0 ? 1 : -1;
      if (Math.abs(dy) >= 128) dirY = dy > 0 ? 1 : -1;
    }
    prevViewportCenterRef.current = { cx, cy };
    return computeThreeRingBounds({ minX, minY, maxX, maxY }, 512, dirX, dirY);
  }, [viewportBucketKey]);

  const chunkManagerRef = useRef<ChunkManager | null>(null);
  const tileCacheRef = useRef(new ChunkTileCache(160));
  const draggingNodeIdsRef = useRef<Set<string>>(new Set());

  const allTemplates = useMemo(
    () => [...customTemplates, ...BUILTIN_TEMPLATES],
    [customTemplates]
  );


  const baseRef = useRef(base);
  baseRef.current = base;
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  const bumpChunkSyncTick = useCallback(() => {
    renderedScriptsRef.current.clear();
    setChunkSyncTick((t) => t + 1);
  }, []);
  const { pushHistory, handleUndo, handleRedo, historyMeta } = useBlueprintHistory(
    baseRef,
    overlayRef,
    setBase,
    setOverlay,
    setStatusLog,
    bumpChunkSyncTick
  );

  // 全局快捷键：Ctrl+K 搜索跳转，Ctrl+Z / Ctrl+Y 撤销重做（输入框聚焦时放行原生撤销）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  // URL Hash 精确分区跳转（/#chunk=cx,cy&zoom=z）
  useEffect(() => {
    const hash = window.location.hash;
    const m = hash.match(/chunk=(-?\d+),(-?\d+)(?:&zoom=(\d+(?:\.\d+)?))?/);
    if (!m) return;
    const cx = Number(m[1]);
    const cy = Number(m[2]);
    const zoom = m[3] ? Math.max(0.15, Math.min(2.2, Number(m[3]))) : 0.85;
    const timer = window.setTimeout(() => {
      rf.setCenter(cx * 512 + 256, cy * 512 + 256, { zoom, duration: 350 });
      setStatusLog(`已按 URL 坐标定位到 Chunk (${cx}, ${cy})`);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [rf]);

  const handleCopyChunkLink = useCallback(async () => {
    const [tx, ty, zoom] = rfStore.getState().transform;
    const centerWorldX = (window.innerWidth * 0.5 - tx) / zoom;
    const centerWorldY = (window.innerHeight * 0.5 - ty) / zoom;
    const cx = Math.floor(centerWorldX / 512);
    const cy = Math.floor(centerWorldY / 512);
    const hash = `#chunk=${cx},${cy}&zoom=${zoom.toFixed(2)}`;
    try {
      window.history.replaceState(null, '', hash);
    } catch {
      // about:blank / srcdoc / file:// 下禁止 replaceState，安全降级
    }
    const baseOrigin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : '';
    const fullUrl = `${baseOrigin}${window.location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setStatusLog(`已复制分区坐标链接：Chunk (${cx}, ${cy}) @ ${Math.round(zoom * 100)}%`);
    } catch {
      setStatusLog(`已更新地址栏坐标：${hash}`);
    }
  }, [rfStore]);

  const handleExportJSON = useCallback(() => {
    const merged = applyOverlayToBase(baseRef.current, overlayRef.current, SELF_CID);
    const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atlas-blueprint-v${merged.version}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatusLog('已导出完整蓝图 JSON 文件');
  }, []);

  const handleImportJSONFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '')) as BaseBlueprint;
        if (!parsed || typeof parsed !== 'object' || !parsed.nodes || typeof parsed.nodes !== 'object' || Array.isArray(parsed.nodes)) {
          setStatusLog('导入失败：JSON 缺少有效的 nodes 对象');
          return;
        }
        const safeNodes: Record<string, BlueprintNode> = {};
        for (const [nid, rawNode] of Object.entries(parsed.nodes as Record<string, Partial<BlueprintNode>>)) {
          if (!rawNode || typeof rawNode !== 'object') continue;
          safeNodes[nid] = {
            ...rawNode,
            id: typeof rawNode.id === 'string' && rawNode.id ? rawNode.id : nid,
            x: toFiniteNum(rawNode.x) ?? 0,
            y: toFiniteNum(rawNode.y) ?? 0,
            width: Math.max(180, toFiniteNum(rawNode.width) ?? 280),
            height: Math.max(100, toFiniteNum(rawNode.height) ?? 180),
            title: typeof rawNode.title === 'string' ? rawNode.title : '未命名控件',
            body: typeof rawNode.body === 'string' ? rawNode.body : '',
            color: typeof rawNode.color === 'string' ? rawNode.color : '#2563EB',
            defaultVars: rawNode.defaultVars && typeof rawNode.defaultVars === 'object' ? rawNode.defaultVars : {},
            rev: Number.isFinite(Number(rawNode.rev)) ? Number(rawNode.rev) : 1,
            cid: typeof rawNode.cid === 'string' ? rawNode.cid : 'imported',
          };
        }
        pushHistory();
        const normalized: BaseBlueprint = {
          version: Number(parsed.version) || 1,
          chunkSize: Number(parsed.chunkSize) || 512,
          nodes: safeNodes,
          annotations: parsed.annotations && typeof parsed.annotations === 'object' && !Array.isArray(parsed.annotations) ? parsed.annotations : {},
          edges: parsed.edges && typeof parsed.edges === 'object' && !Array.isArray(parsed.edges) ? parsed.edges : {},
        };
        const entries = auditBlueprintScripts(normalized);
        renderedScriptsRef.current.clear();
        setScriptLogsByNode({});
        setBase(normalized);
        setOverlay(createEmptyOverlay());
        setChunkSyncTick((t) => t + 1);
        if (entries.length > 0) {
          setUntrustedScriptKeys(new Set(entries.map((e) => e.key)));
          setTrustModalState({ open: true, sourceLabel: file.name, entries });
          setStatusLog(`已导入「${file.name}」，检测到 ${entries.length} 条外部脚本已默认锁定等待审阅`);
        } else {
          setUntrustedScriptKeys(new Set());
          setStatusLog(`已安全导入蓝图「${file.name}」`);
        }
      } catch {
        setStatusLog('导入失败：文件不是合法的 JSON 格式');
      }
    };
    reader.readAsText(file);
  }, [pushHistory]);

  const handleConnectRoom = useCallback(() => {
    // 纯静态模式下 defaultRoomWsUrl() 返回空串，此时不该让协同步骤继续——
    // 直接给一句人话，而不是把空地址丢给 roomClient 换回一个含糊的格式错误。
    if (!roomWsUrl.trim()) {
      setStatusLog('协同不可用：当前是纯静态演示模式，未配置 VITE_BACKEND_WS_URL');
      return;
    }
    if (!roomClientRef.current) {
      roomClientRef.current = new CollaborativeRoomClient(
        SELF_CID,
        (st, info) => {
          setRoomStatus(st);
          if (info) setStatusLog(info);
        },
        (msg) => {
          const mergeTrustEntries = (label: string, newEntries: ScriptAuditEntry[]) => {
            if (newEntries.length === 0) return;
            setUntrustedScriptKeys((prev) => {
              const next = new Set(prev);
              for (const e of newEntries) next.add(e.key);
              return next;
            });
            setTrustModalState((prev) => {
              const byKey = new Map(prev.entries.map((e) => [e.key, e]));
              for (const e of newEntries) byKey.set(e.key, e);
              return { open: true, sourceLabel: label, entries: Array.from(byKey.values()) };
            });
          };
          const recordSyncedMeta = (kind: string, rec: { id: string; rev: number; cid: string }) => {
            const k = `${kind}:${rec.id}`;
            const cur = maxSyncedMetaRef.current.get(k);
            if (!cur || beats(rec, cur)) {
              maxSyncedMetaRef.current.set(k, { id: rec.id, rev: Number(rec.rev) || 0, cid: String(rec.cid || '') });
            }
          };
          const beatsLocalAndSynced = (kind: string, incoming: { id: string; rev: number; cid: string }, cur: { id: string; rev: number; cid: string } | undefined) => {
            if (cur && !beats(incoming, cur)) return false;
            const synced = maxSyncedMetaRef.current.get(`${kind}:${incoming.id}`);
            if (synced && !beats(incoming, synced)) return false;
            return true;
          };
          if (msg.t === 'state' && msg.blueprint) {
            const entries = auditBlueprintScripts(msg.blueprint);
            mergeTrustEntries(`协同房间 ${roomNameRef.current}`, entries);
            for (const n of Object.values(msg.blueprint.nodes ?? {})) recordSyncedMeta('node', n);
            for (const a of Object.values(msg.blueprint.annotations ?? {})) recordSyncedMeta('ann', a);
            for (const e of Object.values(msg.blueprint.edges ?? {})) recordSyncedMeta('edge', e);
            setBase((prev) => {
              const merged = mergeRemoteBlueprintCRDT(prev, msg.blueprint);
              if (prevSyncedBaseRef.current) {
                prevSyncedBaseRef.current = mergeRemoteBlueprintCRDT(prevSyncedBaseRef.current, msg.blueprint);
              }
              return merged;
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }
          if (msg.t === 'upsert_node' && msg.node) {
            const remoteNode = msg.node;
            const curLocal = baseRef.current.nodes[remoteNode.id];
            if (beatsLocalAndSynced('node', remoteNode, curLocal)) {
              recordSyncedMeta('node', remoteNode);
              const singleBp: BaseBlueprint = {
                version: baseRef.current.version,
                chunkSize: baseRef.current.chunkSize,
                nodes: { [remoteNode.id]: remoteNode },
                annotations: {},
                edges: {},
              };
              const entries = auditBlueprintScripts(singleBp);
              const scriptChanged =
                !curLocal ||
                curLocal.script !== remoteNode.script ||
                JSON.stringify(curLocal.buttons ?? []) !== JSON.stringify(remoteNode.buttons ?? []);
              if (entries.length > 0 && scriptChanged) {
                mergeTrustEntries(`协同远端更新 (${remoteNode.title})`, entries);
              }
              setBase((prev) => {
                const cur = prev.nodes[remoteNode.id];
                if (cur && !beats(remoteNode, cur)) return prev;
                if (prevSyncedBaseRef.current) {
                  prevSyncedBaseRef.current = {
                    ...prevSyncedBaseRef.current,
                    nodes: { ...prevSyncedBaseRef.current.nodes, [remoteNode.id]: remoteNode },
                  };
                }
                return {
                  ...prev,
                  version: prev.version + 1,
                  nodes: { ...prev.nodes, [remoteNode.id]: remoteNode },
                };
              });
              setChunkSyncTick((t) => t + 1);
            }
            return;
          }
          if (msg.t === 'delete_node' && msg.id) {
            const delId = msg.id;
            setBase((prev) => {
              if (!prev.nodes[delId]) return prev;
              const nextNodes = { ...prev.nodes };
              delete nextNodes[delId];
              const nextEdges: typeof prev.edges = {};
              for (const [eid, e] of Object.entries(prev.edges)) {
                if (e.source !== delId && e.target !== delId) nextEdges[eid] = e;
              }
              if (prevSyncedBaseRef.current) {
                const sn = { ...prevSyncedBaseRef.current.nodes };
                delete sn[delId];
                const se: typeof prev.edges = {};
                for (const [eid, e] of Object.entries(prevSyncedBaseRef.current.edges)) {
                  if (e.source !== delId && e.target !== delId) se[eid] = e;
                }
                prevSyncedBaseRef.current = { ...prevSyncedBaseRef.current, nodes: sn, edges: se };
              }
              return { ...prev, version: prev.version + 1, nodes: nextNodes, edges: nextEdges };
            });
            setOverlay((prev) => {
              if (!prev.runtimeVars[delId] && !prev.nodePatches[delId]) return prev;
              const nextRv = { ...prev.runtimeVars };
              const nextPatches = { ...prev.nodePatches };
              delete nextRv[delId];
              delete nextPatches[delId];
              return { ...prev, runtimeVars: nextRv, nodePatches: nextPatches };
            });
            renderedScriptsRef.current.delete(delId);
            setScriptLogsByNode((prev) => {
              if (!prev[delId]) return prev;
              const next = { ...prev };
              delete next[delId];
              return next;
            });
            setInspectingNodeId((cur) => (cur === delId ? null : cur));
            setChunkSyncTick((t) => t + 1);
            return;
          }
          if (msg.t === 'upsert_ann' && msg.annotation) {
            const remoteAnn = msg.annotation;
            if (!beatsLocalAndSynced('ann', remoteAnn, baseRef.current.annotations[remoteAnn.id])) return;
            recordSyncedMeta('ann', remoteAnn);
            setBase((prev) => {
              const cur = prev.annotations[remoteAnn.id];
              if (cur && !beats(remoteAnn, cur)) return prev;
              if (prevSyncedBaseRef.current) {
                prevSyncedBaseRef.current = {
                  ...prevSyncedBaseRef.current,
                  annotations: { ...prevSyncedBaseRef.current.annotations, [remoteAnn.id]: remoteAnn },
                };
              }
              return { ...prev, version: prev.version + 1, annotations: { ...prev.annotations, [remoteAnn.id]: remoteAnn } };
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }
          if (msg.t === 'delete_ann' && msg.id) {
            const delId = msg.id;
            setBase((prev) => {
              if (!prev.annotations[delId]) return prev;
              const nextAnns = { ...prev.annotations };
              delete nextAnns[delId];
              if (prevSyncedBaseRef.current) {
                const sa = { ...prevSyncedBaseRef.current.annotations };
                delete sa[delId];
                prevSyncedBaseRef.current = { ...prevSyncedBaseRef.current, annotations: sa };
              }
              return { ...prev, version: prev.version + 1, annotations: nextAnns };
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }
          if (msg.t === 'upsert_edge' && msg.edge) {
            const remoteEdge = msg.edge;
            if (!beatsLocalAndSynced('edge', remoteEdge, baseRef.current.edges[remoteEdge.id])) return;
            recordSyncedMeta('edge', remoteEdge);
            setBase((prev) => {
              const cur = prev.edges[remoteEdge.id];
              if (cur && !beats(remoteEdge, cur)) return prev;
              if (prevSyncedBaseRef.current) {
                prevSyncedBaseRef.current = {
                  ...prevSyncedBaseRef.current,
                  edges: { ...prevSyncedBaseRef.current.edges, [remoteEdge.id]: remoteEdge },
                };
              }
              return { ...prev, version: prev.version + 1, edges: { ...prev.edges, [remoteEdge.id]: remoteEdge } };
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }
          if (msg.t === 'delete_edge' && msg.id) {
            const delId = msg.id;
            setBase((prev) => {
              if (!prev.edges[delId]) return prev;
              const nextEdges = { ...prev.edges };
              delete nextEdges[delId];
              if (prevSyncedBaseRef.current) {
                const se = { ...prevSyncedBaseRef.current.edges };
                delete se[delId];
                prevSyncedBaseRef.current = { ...prevSyncedBaseRef.current, edges: se };
              }
              return { ...prev, version: prev.version + 1, edges: nextEdges };
            });
            setChunkSyncTick((t) => t + 1);
          }
        }
      );
    }
    maxSyncedMetaRef.current.clear();
    roomClientRef.current.connect(roomWsUrl, roomName);
    setRoomModalOpen(false);
  }, [roomWsUrl, roomName]);

  useEffect(() => {
    return () => {
      roomClientRef.current?.disconnect();
    };
  }, []);

  // 协同房间上行增量推送：已联机时将本地 base 变更经 computeRecordDiff 增量发送至房间（远端落盘已直接并入 prevSyncedBaseRef，同帧本地修改绝不丢失）
  useEffect(() => {
    if (roomStatus !== 'connected' || !roomClientRef.current) {
      if (roomStatus === 'disconnected') maxSyncedMetaRef.current.clear();
      prevSyncedBaseRef.current = base;
      return;
    }
    const prev = prevSyncedBaseRef.current;
    prevSyncedBaseRef.current = base;
    if (!prev) {
      roomClientRef.current.send({ t: 'state', blueprint: base });
      return;
    }
    const bumpRev = <T extends { id: string; rev: number; cid: string }>(kind: string, rec: T): T => {
      const k = `${kind}:${rec.id}`;
      const highest = Math.max(maxSyncedMetaRef.current.get(k)?.rev ?? 0, Number(rec.rev) || 0);
      const nextRev = highest + 1;
      maxSyncedMetaRef.current.set(k, { id: rec.id, rev: nextRev, cid: SELF_CID });
      return { ...rec, rev: nextRev, cid: SELF_CID };
    };
    const nodeDiff = computeRecordDiff(prev.nodes, base.nodes, SELF_CID);
    for (const node of nodeDiff.upserts) roomClientRef.current.send({ t: 'upsert_node', node: bumpRev('node', node) });
    for (const id of nodeDiff.deletes) roomClientRef.current.send({ t: 'delete_node', id });
    const annDiff = computeRecordDiff(prev.annotations, base.annotations, SELF_CID);
    for (const annotation of annDiff.upserts) roomClientRef.current.send({ t: 'upsert_ann', annotation: bumpRev('ann', annotation) });
    for (const id of annDiff.deletes) roomClientRef.current.send({ t: 'delete_ann', id });
    const edgeDiff = computeRecordDiff(prev.edges, base.edges, SELF_CID);
    for (const edge of edgeDiff.upserts) roomClientRef.current.send({ t: 'upsert_edge', edge: bumpRev('edge', edge) });
    for (const id of edgeDiff.deletes) roomClientRef.current.send({ t: 'delete_edge', id });
  }, [base, roomStatus]);

  const effectiveNodes = useMemo(() => resolveEffectiveNodes(base, overlay), [base, overlay]);
  const effectiveAnnotations = useMemo(
    () => resolveEffectiveAnnotations(base, overlay),
    [base, overlay]
  );
  const effectiveNodesRef = useRef(effectiveNodes);
  const validateConnectionByWidgetsRef = useRef<
    (source: string, target: string, fromPort: string, toPort: string, activeEdgeMap: Record<string, BlueprintEdge>) => Promise<{ ok: boolean; reason?: string }>
  >(async () => ({ ok: true }));
  const edgesRef = useRef(base.edges);
  edgesRef.current = base.edges;
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
    setRenderVersion((v) => v + 1);
  }, [base.version, effectiveAnnotations, lod, annotationEditMode, chunkSyncTick]);

  // 仅在切换注释编辑模式时清空瓦片缓存，常规节点编辑由分块级签名精准失效
  useEffect(() => {
    tileCacheRef.current.clear();
  }, [annotationEditMode]);

  // 启动时从 IndexedDB 恢复本地叠加层、自定义模板与已发布底座
  useEffect(() => {
    let active = true;
    void (async () => {
      const [savedOverlay, savedTpls] = await Promise.all([
        loadLocalOverlay(),
        loadCustomTemplates(),
      ]);
      if (!active) return;
      try {
        const resp = await fetch('/api/blueprint');
        if (resp.ok) {
          const data = (await resp.json()) as { ok?: boolean; blueprint?: BaseBlueprint | null };
          if (active && data.ok && data.blueprint && data.blueprint.nodes) {
            renderedScriptsRef.current.clear();
            setBase(data.blueprint);
          }
        }
      } catch {
        // 离线或无后端时继续使用种子蓝图
      }
      if (!active) return;
      overlayHydratedRef.current = true;
      setOverlayHydrated(true);
      setOverlay(savedOverlay);
      setCustomTemplates(savedTpls);
      setChunkSyncTick((t) => t + 1);
    })();
    return () => {
      active = false;
    };
  }, []);

  // 本地叠加层 300ms 防抖写盘 + beforeunload 刷盘 + BroadcastChannel 跨页签防回环同步
  const handleRemoteOverlayApplied = useCallback(() => setChunkSyncTick((t) => t + 1), []);
  useOverlaySync(overlay, overlayHydrated, setOverlay, setStatusLog, handleRemoteOverlayApplied);

  // 实例化任意模板到指定世界坐标
  const instantiateTemplateAt = useCallback((tpl: BlueprintTemplate, worldX: number, worldY: number) => {
    pushHistory();
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
      const existingBoxes: RectBox[] = Object.values(effectiveNodesRef.current).map((n) => ({
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
      }));
      const placed = findNonOverlappingPosition(
        { x, y, width: tpl.nodePreset.width, height: tpl.nodePreset.height },
        existingBoxes,
        { gap: 20 }
      );
      const newNode: BlueprintNode = {
        ...tpl.nodePreset,
        id,
        x: placed.x,
        y: placed.y,
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
  }, [pushHistory]);

  const handleCreateTemplateCenter = useCallback(
    (tpl: BlueprintTemplate) => {
      const [tx, ty, rawZoom] = rfStore.getState().transform;
      const zoom = Math.max(0.1, rawZoom || 1);
      const offset = Math.round((Math.random() - 0.5) * 60);
      const centerX = (window.innerWidth * 0.55 - tx) / zoom - 140 + offset;
      const centerY = (window.innerHeight * 0.5 - ty) / zoom - 80 + offset;
      instantiateTemplateAt(tpl, centerX, centerY);
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setTemplateDrawerOpen(false);
      }
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

  const executeUnifiedWidgetScriptRef = useRef<
    (
      nodeId: string,
      trigger: ScriptTriggerEvent,
      overrideVars?: Record<string, unknown>,
      depth?: number,
      peerOverrides?: Record<string, Partial<PeerWidgetSnapshot>>,
      edgesOverride?: Record<string, BlueprintEdge>
    ) => Promise<void>
  >(async () => {});

  const handleRunButton = useCallback(async (nodeId: string, btn: WidgetButtonSpec) => {
    const entity = effectiveNodesRef.current[nodeId];
    if (!entity) return;
    const key = `${nodeId}:${btn.id}`;
    setBusyButtonKey(key);

    try {
      if (untrustedScriptKeysRef.current.has(`${nodeId}:${btn.id}`)) {
        setTrustModalState((s) => ({ ...s, open: true }));
        setStatusLog('该外部按钮脚本尚未获得信任授权，请先在审计弹窗中审阅');
        return;
      }
      if (btn.actionType === 'script' && btn.code) {
        const peers = buildPeerSnapshots(effectiveNodesRef.current);
        const edgesSnap = buildEdgeSnapshots(edgesRef.current);
        const res = await runInIsolatedWorker(btn.code, entity.effectiveVars, {
          selfEntity: peers[nodeId],
          peers,
          edges: edgesSnap,
        });
        if (!res.ok) {
          appendNodeLogs(nodeId, `btn:${btn.label}`, [
            ...res.logs.map((m) => ({ level: 'log' as const, message: m })),
            { level: 'error', message: res.error || '脚本运行失败' },
          ]);
          setStatusLog(`沙箱拦截/报错：${res.error}`);
          return;
        }
        if (res.logs.length > 0) {
          appendNodeLogs(
            nodeId,
            `btn:${btn.label}`,
            res.logs.map((m) => ({ level: 'log' as const, message: m }))
          );
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
        const touchedLayoutOrStyle = ['x', 'y', 'pos', 'width', 'height', 'title', 'color', 'type', 'category'].some(
          (k) => k in res.updatedVars
        );
        if (res.annotationOps.length > 0 || touchedLayoutOrStyle) {
          setChunkSyncTick((t) => t + 1);
        }
        const freshOverrides = { [nodeId]: { vars: res.updatedVars } };
        const notifiedIds = new Set<string>();
        const fanoutTasks: Array<Promise<void>> = [];
        // 与统一脚本路径一致：按 targetId + event 归并，避免同一脚本被并发执行后覆盖彼此结果
        const mergedEmits = new Map<string, { targetId: string; event: string; payloads: unknown[] }>();
        for (const em of res.emitOps) {
          const targets =
            em.targetId === '*'
              ? Object.values(effectiveNodesRef.current)
                  .filter((n) => n.id !== nodeId && Boolean(n.script))
                  .map((n) => n.id)
              : [em.targetId];
          for (const tid of targets) {
            notifiedIds.add(tid);
            const key = `${tid}\u0000${em.event}`;
            const bucket = mergedEmits.get(key);
            if (bucket) {
              bucket.payloads.push(em.payload);
            } else {
              mergedEmits.set(key, { targetId: tid, event: em.event, payloads: [em.payload] });
            }
          }
        }
        for (const { targetId: tid, event, payloads } of mergedEmits.values()) {
          const payload = payloads.length === 1 ? payloads[0] : payloads;
          fanoutTasks.push(
            executeUnifiedWidgetScriptRef.current(
              tid,
              { kind: 'message', event, payload, fromId: nodeId, fromTitle: entity.title },
              undefined,
              1,
              freshOverrides
            )
          );
        }
        const downstreamIds = Array.from(
          new Set(
            Object.values(edgesRef.current)
              .filter((e) => e.source === nodeId && e.target !== nodeId && !notifiedIds.has(e.target))
              .map((e) => e.target)
          )
        ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
        for (const dstId of downstreamIds) {
          fanoutTasks.push(
            executeUnifiedWidgetScriptRef.current(dstId, { kind: 'render' }, undefined, 1, freshOverrides)
          );
        }
        if (fanoutTasks.length > 0) {
          await Promise.all(fanoutTasks);
        }
        setStatusLog(res.logs.length > 0 ? `Worker 输出：${res.logs.join(' | ')}` : `已更新本地 vars (${entity.title})`);
      } else if (btn.actionType === 'proxy_http' && btn.proxyUrl) {
        const resp = await fetch('/api/proxy', {
          method: 'POST',
          headers: proxyHeaders({ 'Content-Type': 'application/json' }),
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
    (
      sourceNodes: Record<string, EffectiveBlueprintNode>,
      overrides?: Record<string, Partial<PeerWidgetSnapshot>>
    ): Record<string, PeerWidgetSnapshot> => {
      const peers: Record<string, PeerWidgetSnapshot> = {};
      for (const n of Object.values(sourceNodes)) {
        const ov = overrides?.[n.id];
        peers[n.id] = {
          id: n.id,
          title: ov?.title ?? n.title,
          label: ov?.label ?? ov?.title ?? n.title,
          body: ov?.body ?? n.body ?? '',
          x: ov?.x ?? n.x,
          y: ov?.y ?? n.y,
          width: ov?.width ?? n.width,
          height: ov?.height ?? n.height,
          color: ov?.color ?? n.color,
          vars: ov?.vars ? { ...ov.vars } : { ...n.effectiveVars },
        };
      }
      return peers;
    },
    []
  );

  const buildEdgeSnapshots = useCallback(
    (edgeMap: Record<string, BlueprintEdge>): EdgeSnapshot[] =>
      Object.values(edgeMap).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        label: e.label,
      })),
    []
  );

  // 统一脚本调度器：支持 render / click / submit / message，递归处理 widgets.create/connect/remove 与 emit/broadcast/emitDownstream，并自动刷新下游连线控件
  const executeUnifiedWidgetScript = useCallback(
    async (
      nodeId: string,
      trigger: ScriptTriggerEvent,
      overrideVars?: Record<string, unknown>,
      depth = 0,
      peerOverrides?: Record<string, Partial<PeerWidgetSnapshot>>,
      edgesOverride?: Record<string, BlueprintEdge>
    ) => {
      // 断环器：自由拓扑下允许存在环，递归超过 5 层（depth > 4）时立即中止并在通知位提示，防止无限递归。
      if (depth > 4) {
        setStatusLog(`事件链已连续传导 5 层，为避免环路无限递归已中止（最后一次触发：${effectiveNodesRef.current[nodeId]?.title ?? nodeId}）`);
        return;
      }
      const entity = effectiveNodesRef.current[nodeId];
      if (!entity || !entity.script) return;
      if (untrustedScriptKeysRef.current.has(`${nodeId}:__script__`)) {
        if (trigger.kind !== 'render') {
          setTrustModalState((s) => ({ ...s, open: true }));
          setStatusLog('该外部控件脚本处于安全只读锁定态，请先审阅信任');
        }
        return;
      }

      const activeEdges = edgesOverride ?? edgesRef.current;
      const peers = buildPeerSnapshots(effectiveNodesRef.current, peerOverrides);
      const edgesSnap = buildEdgeSnapshots(activeEdges);
      const selfEntity = peers[nodeId];
      const inputVars = overrideVars ?? entity.effectiveVars;
      const res = await runInIsolatedWorker(entity.script, inputVars, {
        selfEntity,
        peers,
        edges: edgesSnap,
        trigger,
      });

      const triggerTag =
        trigger.kind === 'click'
          ? `click:${trigger.buttonId}`
          : trigger.kind === 'submit'
            ? `submit:${trigger.inputId}`
            : trigger.kind === 'message'
              ? `msg:${trigger.event}`
              : trigger.kind === 'varsChanged'
                ? `var:${trigger.changedKeys.join(',')}`
                : trigger.kind;
      if (!res.ok) {
        appendNodeLogs(nodeId, triggerTag, [
          ...res.logs.map((m) => ({ level: 'log' as const, message: m })),
          { level: 'error', message: res.error || '脚本运行失败' },
        ]);
        setStatusLog(`脚本错误 (${entity.title})：${res.error}`);
        return;
      }
      if (res.logs.length > 0) {
        appendNodeLogs(
          nodeId,
          triggerTag,
          res.logs.map((m) => ({ level: 'log' as const, message: m }))
        );
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

      // 2) 处理 widgets.create / connect / remove 指令（先对脚本发起的 connect 执行控件自主 onValidateConnect 校验）
      const approvedConnectOps = new Set<number>();
      for (let i = 0; i < res.widgetOps.length; i++) {
        const op = res.widgetOps[i];
        if (op.op === 'connect') {
          const check = await validateConnectionByWidgetsRef.current(
            op.fromId,
            op.toId,
            'out-1',
            'in-1',
            activeEdges
          );
          if (check.ok) {
            approvedConnectOps.add(i);
          } else {
            setStatusLog(check.reason || '目标控件拒绝了脚本连线');
          }
        }
      }
      const newlyCreatedScripts: Array<{
        id: string;
        title: string;
        body: string;
        x: number;
        y: number;
        width: number;
        height: number;
        color: string;
        vars: Record<string, unknown>;
        script: string;
      }> = [];
      const createdEdges: Record<string, BlueprintEdge> = { ...activeEdges };
      if (res.widgetOps.length > 0) {
        const occupiedBoxes: RectBox[] = Object.values(effectiveNodesRef.current).map((n) => ({
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
        }));
        const batchNodesToAdd: BlueprintNode[] = [];
        const batchEdgesToAdd: BlueprintEdge[] = [];
        const batchNodeIdsToRemove = new Set<string>();
        const nowTs = Date.now();

        for (let opIdx = 0; opIdx < res.widgetOps.length; opIdx++) {
          const op = res.widgetOps[opIdx];
          if (op.op === 'create') {
            const placed = findNonOverlappingPosition(
              { x: op.x, y: op.y, width: op.width, height: op.height },
              occupiedBoxes,
              { gap: 20 }
            );
            occupiedBoxes.push({ x: placed.x, y: placed.y, width: op.width, height: op.height });
            const newNode: BlueprintNode = {
              id: op.id,
              x: placed.x,
              y: placed.y,
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
            batchNodesToAdd.push(newNode);
            if (op.script) {
              newlyCreatedScripts.push({
                id: op.id,
                title: op.title,
                body: op.body || '',
                x: placed.x,
                y: placed.y,
                width: op.width,
                height: op.height,
                color: op.color,
                vars: op.vars || {},
                script: op.script,
              });
            }
            if (op.connect) {
              const eid = `edge-${nodeId}-${op.id}-${nowTs}-${opIdx}`;
              const createdEdge: BlueprintEdge = {
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
              batchEdgesToAdd.push(createdEdge);
              createdEdges[eid] = createdEdge;
            }
          } else if (op.op === 'connect') {
            if (!approvedConnectOps.has(opIdx)) continue;
            const eid = `edge-${op.fromId}-${op.toId}-${nowTs}-${opIdx}`;
            const createdEdge: BlueprintEdge = {
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
            batchEdgesToAdd.push(createdEdge);
            createdEdges[eid] = createdEdge;
          } else if (op.op === 'remove') {
            batchNodeIdsToRemove.add(op.id);
            for (const [eid, e] of Object.entries(createdEdges)) {
              if (e.source === op.id || e.target === op.id) delete createdEdges[eid];
            }
          }
        }

        for (const child of newlyCreatedScripts) {
          renderedScriptsRef.current.add(child.id);
        }
        setBase((prev) => {
          const nextNodes = { ...prev.nodes };
          const nextEdges = { ...prev.edges };
          for (const n of batchNodesToAdd) nextNodes[n.id] = n;
          for (const e of batchEdgesToAdd) nextEdges[e.id] = e;
          for (const rid of batchNodeIdsToRemove) {
            delete nextNodes[rid];
            for (const [eid, e] of Object.entries(nextEdges)) {
              if (e.source === rid || e.target === rid) delete nextEdges[eid];
            }
          }
          return { ...prev, version: prev.version + 1, nodes: nextNodes, edges: nextEdges };
        });
      }

      const touchedLayout = ['x', 'y', 'pos', 'width', 'height'].some((k) => k in res.updatedVars);
      if (res.annotationOps.length > 0 || res.widgetOps.length > 0 || touchedLayout) {
        setChunkSyncTick((t) => t + 1);
      }

      // 新建的带脚本子控件并发跑一次 render，注入真实标题/坐标/尺寸与最新连线快照
      if (newlyCreatedScripts.length > 0) {
        const freshEdgesSnap = buildEdgeSnapshots(createdEdges);
        await Promise.all(
          newlyCreatedScripts.map(async (child) => {
            const childRes = await runInIsolatedWorker(child.script, child.vars, {
              selfEntity: {
                id: child.id,
                title: child.title,
                label: child.title,
                body: child.body,
                x: child.x,
                y: child.y,
                width: child.width,
                height: child.height,
                color: child.color,
                vars: child.vars,
              },
              peers,
              edges: freshEdgesSnap,
              trigger: { kind: 'render' },
            });
            if (childRes.ok) {
              setOverlay((prev) => ({
                ...prev,
                runtimeVars: { ...prev.runtimeVars, [child.id]: childRes.updatedVars },
              }));
            }
          })
        );
      }

      const nextPeerOverrides: Record<string, Partial<PeerWidgetSnapshot>> = {
        ...(peerOverrides ?? {}),
        [nodeId]: { ...(peerOverrides?.[nodeId] ?? {}), vars: res.updatedVars },
      };

      // 3) 处理跨控件 emit / broadcast / emitDownstream 事件投递（扇出目标通过 Promise.all 并发同时驱动）
      // 注意：同一目标可能被多条 emitOp 命中（脚本 emit 两次、或 broadcast 与 emitDownstream 重叠、
      // 或多条边指向同一 target）。串行版是逐个 await 的独立执行；并发后若不去重，同一脚本会被
      // 多个 Worker 同时跑，各自拿同一份 inputVars，最后由 setOverlay 的后写者覆盖前写者 —— 丢更新。
      // 因此按 targetId + event 归并，同目标同事件的载荷合并成一次投递。
      const notifiedIds = new Set<string>();
      const emitTasks: Array<Promise<void>> = [];
      const mergedEmits = new Map<string, { targetId: string; event: string; payloads: unknown[] }>();
      for (const em of res.emitOps) {
        const targets =
          em.targetId === '*'
            ? Object.values(effectiveNodesRef.current)
                .filter((n) => n.id !== nodeId && Boolean(n.script))
                .map((n) => n.id)
            : [em.targetId];
        for (const tid of targets) {
          notifiedIds.add(tid);
          const key = `${tid}\u0000${em.event}`;
          const bucket = mergedEmits.get(key);
          if (bucket) {
            bucket.payloads.push(em.payload);
          } else {
            mergedEmits.set(key, { targetId: tid, event: em.event, payloads: [em.payload] });
          }
        }
      }
      for (const { targetId: tid, event, payloads } of mergedEmits.values()) {
        // 单条载荷保持原样传入，多载荷包成数组，接收方无需区分正常/合并两种情况
        const payload = payloads.length === 1 ? payloads[0] : payloads;
        emitTasks.push(
          executeUnifiedWidgetScript(
            tid,
            {
              kind: 'message',
              event,
              payload,
              fromId: nodeId,
              fromTitle: entity.title,
            },
            undefined,
            depth + 1,
            nextPeerOverrides,
            createdEdges
          )
        );
      }
      if (emitTasks.length > 0) {
        await Promise.all(emitTasks);
      }

      // 4) 若本次交互修改了自身状态，并发同时刷新所有通过连线接在下游的脚本控件（扇出同步生效）
      if (trigger.kind !== 'render') {
        const downstreamIds = Array.from(
          new Set(
            Object.values(createdEdges)
              .filter((e) => e.source === nodeId && e.target !== nodeId && !notifiedIds.has(e.target))
              .map((e) => e.target)
          )
        ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
        if (downstreamIds.length > 0) {
          await Promise.all(
            downstreamIds.map((dstId) =>
              executeUnifiedWidgetScript(
                dstId,
                { kind: 'render' },
                undefined,
                depth + 1,
                nextPeerOverrides,
                createdEdges
              )
            )
          );
        }
      }
    },
    [buildEdgeSnapshots, buildPeerSnapshots, appendNodeLogs]
  );
  executeUnifiedWidgetScriptRef.current = executeUnifiedWidgetScript;

  // 初始化所有带 script 的控件：严格等待 IndexedDB 恢复完成后再首次渲染，避免恢复覆盖冲掉首帧 vars.contents
  const renderedScriptsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!overlayHydrated) return;
    const preloadBox = threeRingBounds.domPreloadBounds;
    for (const node of Object.values(effectiveNodes)) {
      if (!node.script || Array.isArray(node.effectiveVars?.contents) || renderedScriptsRef.current.has(node.id)) {
        continue;
      }
      const nodeBox = {
        minX: node.x,
        minY: node.y,
        maxX: node.x + node.width,
        maxY: node.y + node.height,
      };
      if (!isBoxIntersecting(nodeBox, preloadBox)) continue;
      renderedScriptsRef.current.add(node.id);
      void executeUnifiedWidgetScript(node.id, { kind: 'render' });
    }
  }, [overlayHydrated, effectiveNodes, threeRingBounds, executeUnifiedWidgetScript, untrustedScriptKeys]);

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

  const handleSliderChange = useCallback((nodeId: string, bindKey: string, value: number) => {
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

  const handleSliderCommit = useCallback(
    (nodeId: string, bindKey: string, value: number) => {
      pushHistory();
      const prevEntity = effectiveNodesRef.current[nodeId];
      const prevVars = prevEntity ? { ...prevEntity.effectiveVars } : {};
      const nextVars = { ...prevVars, [bindKey]: value };
      setOverlay((prev) => ({
        ...prev,
        runtimeVars: {
          ...prev.runtimeVars,
          [nodeId]: {
            ...(prev.runtimeVars[nodeId] ?? prevVars),
            [bindKey]: value,
          },
        },
      }));
      if (prevEntity?.script) {
        void executeUnifiedWidgetScript(
          nodeId,
          { kind: 'varsChanged', prevVars, changedKeys: [bindKey] },
          nextVars
        );
      }
      const downstreamIds = Array.from(
        new Set(
          Object.values(edgesRef.current)
            .filter((e) => e.source === nodeId && e.target !== nodeId)
            .map((e) => e.target)
        )
      ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
      for (const dstId of downstreamIds) {
        void executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
          [nodeId]: { vars: nextVars },
        });
      }
    },
    [executeUnifiedWidgetScript, pushHistory]
  );

  const handlePad2DChange = useCallback(
    (nodeId: string, bindX: string, x: number, bindY: string, y: number) => {
      setOverlay((prev) => ({
        ...prev,
        runtimeVars: {
          ...prev.runtimeVars,
          [nodeId]: {
            ...(prev.runtimeVars[nodeId] ?? effectiveNodesRef.current[nodeId]?.effectiveVars ?? {}),
            [bindX]: x,
            [bindY]: y,
          },
        },
      }));
    },
    []
  );

  const handlePad2DCommit = useCallback(
    (nodeId: string, bindX: string, x: number, bindY: string, y: number) => {
      pushHistory();
      const prevEntity = effectiveNodesRef.current[nodeId];
      const prevVars = prevEntity ? { ...prevEntity.effectiveVars } : {};
      const nextVars = { ...prevVars, [bindX]: x, [bindY]: y };
      setOverlay((prev) => ({
        ...prev,
        runtimeVars: {
          ...prev.runtimeVars,
          [nodeId]: {
            ...(prev.runtimeVars[nodeId] ?? prevVars),
            [bindX]: x,
            [bindY]: y,
          },
        },
      }));
      if (prevEntity?.script) {
        void executeUnifiedWidgetScript(
          nodeId,
          { kind: 'varsChanged', prevVars, changedKeys: [bindX, bindY] },
          nextVars
        );
      }
      const downstreamIds = Array.from(
        new Set(
          Object.values(edgesRef.current)
            .filter((e) => e.source === nodeId && e.target !== nodeId)
            .map((e) => e.target)
        )
      ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
      for (const dstId of downstreamIds) {
        void executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
          [nodeId]: { vars: nextVars },
        });
      }
    },
    [executeUnifiedWidgetScript, pushHistory]
  );

  const handleImageButtonTrigger = useCallback(
    (nodeId: string, buttonId: string, bindKey: string, nextIsOn: boolean, toggle: boolean) => {
      pushHistory();
      const prevEntity = effectiveNodesRef.current[nodeId];
      const prevVars = prevEntity ? { ...prevEntity.effectiveVars } : {};
      const nextVars = toggle ? { ...prevVars, [bindKey]: nextIsOn } : prevVars;
      if (toggle) {
        setOverlay((prev) => ({
          ...prev,
          runtimeVars: {
            ...prev.runtimeVars,
            [nodeId]: {
              ...(prev.runtimeVars[nodeId] ?? prevVars),
              [bindKey]: nextIsOn,
            },
          },
        }));
      }
      if (prevEntity?.script) {
        void executeUnifiedWidgetScript(nodeId, { kind: 'click', buttonId }, nextVars);
      }
      if (toggle) {
        const downstreamIds = Array.from(
          new Set(
            Object.values(edgesRef.current)
              .filter((e) => e.source === nodeId && e.target !== nodeId)
              .map((e) => e.target)
          )
        ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
        for (const dstId of downstreamIds) {
          void executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
            [nodeId]: { vars: nextVars },
          });
        }
      }
    },
    [executeUnifiedWidgetScript, pushHistory]
  );

  const handleBatchUpdateRuntimeVars = useCallback(
    (nodeId: string, patch: Record<string, unknown>, notifyDownstream = true) => {
      pushHistory();
      const baseVars = overlayRef.current.runtimeVars[nodeId] ?? effectiveNodesRef.current[nodeId]?.effectiveVars ?? {};
      const nextVars = { ...baseVars, ...patch };
      setOverlay((prev) => ({
        ...prev,
        runtimeVars: {
          ...prev.runtimeVars,
          [nodeId]: {
            ...(prev.runtimeVars[nodeId] ?? effectiveNodesRef.current[nodeId]?.effectiveVars ?? {}),
            ...patch,
          },
        },
      }));
      if (!notifyDownstream) return;
      const downstreamIds = Array.from(
        new Set(
          Object.values(edgesRef.current)
            .filter((e) => e.source === nodeId && e.target !== nodeId)
            .map((e) => e.target)
        )
      ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
      for (const dstId of downstreamIds) {
        void executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
          [nodeId]: { vars: nextVars },
        });
      }
    },
    [executeUnifiedWidgetScript, pushHistory]
  );

  const handleScriptInputSubmit = useCallback(
    async (nodeId: string, inputId: string, value: string) => {
      await executeUnifiedWidgetScript(nodeId, { kind: 'submit', inputId, value });
    },
    [executeUnifiedWidgetScript]
  );

  const handleToggleLock = useCallback((nodeId: string) => {
    const cur = effectiveNodesRef.current[nodeId];
    if (!cur) return;
    pushHistory();
    const nextLocked = !cur.locked;
    setOverlay((prev) => {
      const cleanedRt = clearConflictingRuntimeVars(prev.runtimeVars[nodeId], { locked: nextLocked });
      const nextRuntimeVars =
        cleanedRt !== prev.runtimeVars[nodeId]
          ? { ...prev.runtimeVars, [nodeId]: cleanedRt! }
          : prev.runtimeVars;
      return {
        ...prev,
        runtimeVars: nextRuntimeVars,
        nodePatches: {
          ...prev.nodePatches,
          [nodeId]: { ...(prev.nodePatches[nodeId] ?? {}), locked: nextLocked },
        },
      };
    });
    setChunkSyncTick((t) => t + 1);
    setStatusLog(nextLocked ? `已锁定「${cur.title}」（防误拖，按钮与输入框仍可操作）` : `已解锁「${cur.title}」`);
  }, [pushHistory]);

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
    const baseNode = baseRef.current.nodes[nodeId];
    const downstreamIds = Array.from(
      new Set(
        Object.values(edgesRef.current)
          .filter((e) => e.source === nodeId && e.target !== nodeId)
          .map((e) => e.target)
      )
    ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
    if (baseNode && downstreamIds.length > 0) {
      void Promise.all(
        downstreamIds.map((dstId) =>
          executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
            [nodeId]: {
              title: baseNode.title,
              label: baseNode.title,
              body: baseNode.body,
              vars: { ...baseNode.defaultVars },
            },
          })
        )
      );
    }
    setStatusLog('已将该节点重置为后端权威默认值');
  }, [executeUnifiedWidgetScript]);

  const handlePatchNode = useCallback((nodeId: string, patch: Partial<EffectiveBlueprintNode>) => {
    pushHistory();
    setOverlay((prev) => {
      const cleanedRt = clearConflictingRuntimeVars(prev.runtimeVars[nodeId], patch);
      const nextRuntimeVars =
        cleanedRt !== prev.runtimeVars[nodeId]
          ? { ...prev.runtimeVars, [nodeId]: cleanedRt! }
          : prev.runtimeVars;
      return {
        ...prev,
        runtimeVars: nextRuntimeVars,
        nodePatches: {
          ...prev.nodePatches,
          [nodeId]: {
            ...(prev.nodePatches[nodeId] ?? {}),
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.body !== undefined ? { body: patch.body } : {}),
            ...(patch.category !== undefined ? { category: patch.category } : {}),
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.x !== undefined ? { x: patch.x } : {}),
            ...(patch.y !== undefined ? { y: patch.y } : {}),
            ...(patch.width !== undefined ? { width: patch.width } : {}),
            ...(patch.height !== undefined ? { height: patch.height } : {}),
            ...(patch.buttons !== undefined ? { buttons: patch.buttons } : {}),
            ...(patch.script !== undefined ? { script: patch.script } : {}),
            ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
            ...(patch.inputPorts !== undefined ? { inputPorts: patch.inputPorts } : {}),
            ...(patch.outputPorts !== undefined ? { outputPorts: patch.outputPorts } : {}),
          },
        },
      };
    });
    if (
      patch.x !== undefined ||
      patch.y !== undefined ||
      patch.width !== undefined ||
      patch.height !== undefined ||
      patch.title !== undefined ||
      patch.color !== undefined ||
      patch.category !== undefined ||
      patch.locked !== undefined
    ) {
      setChunkSyncTick((t) => t + 1);
    }
  }, [pushHistory]);

  const handleEditTitle = useCallback(
    (nodeId: string, nextTitle: string) => {
      handlePatchNode(nodeId, { title: nextTitle });
      const downstreamIds = Array.from(
        new Set(
          Object.values(edgesRef.current)
            .filter((e) => e.source === nodeId && e.target !== nodeId)
            .map((e) => e.target)
        )
      ).filter((dstId) => Boolean(effectiveNodesRef.current[dstId]?.script));
      if (downstreamIds.length > 0) {
        void Promise.all(
          downstreamIds.map((dstId) =>
            executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
              [nodeId]: { title: nextTitle, label: nextTitle },
            })
          )
        );
      }
    },
    [executeUnifiedWidgetScript, handlePatchNode]
  );

  const handleEditBody = useCallback(
    (nodeId: string, nextBody: string) => {
      handlePatchNode(nodeId, { body: nextBody });
      const downstreamIds = Array.from(
        new Set(
          Object.values(edgesRef.current)
            .filter((e) => e.source === nodeId && e.target !== nodeId)
            .map((e) => e.target)
        )
      );
      for (const dstId of downstreamIds) {
        if (effectiveNodesRef.current[dstId]?.script) {
          void executeUnifiedWidgetScript(dstId, { kind: 'render' }, undefined, 1, {
            [nodeId]: { body: nextBody },
          });
        }
      }
    },
    [executeUnifiedWidgetScript, handlePatchNode]
  );

  const handleResizeNode = useCallback(
    (nodeId: string, width: number, height: number, x?: number, y?: number) => {
      handlePatchNode(nodeId, {
        width,
        height,
        ...(x !== undefined && Number.isFinite(x) ? { x } : {}),
        ...(y !== undefined && Number.isFinite(y) ? { y } : {}),
      });
      setChunkSyncTick((t) => t + 1);
    },
    [handlePatchNode]
  );

  const handleUpdateDefaultVar = useCallback((nodeId: string, key: string, rawVal: string) => {
    pushHistory();
    let parsed: unknown = rawVal;
    if (rawVal === 'true') parsed = true;
    else if (rawVal === 'false') parsed = false;
    else if (rawVal !== '' && Number.isFinite(Number(rawVal))) parsed = Number(rawVal);

    const prevEntity = effectiveNodesRef.current[nodeId];
    const prevVars = prevEntity ? { ...prevEntity.effectiveVars } : {};
    const nextEffectiveVars = { ...prevVars, [key]: parsed };

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
    setOverlay((prev) => {
      const curRv = prev.runtimeVars[nodeId];
      if (!curRv) return prev;
      return {
        ...prev,
        runtimeVars: {
          ...prev.runtimeVars,
          [nodeId]: { ...curRv, [key]: parsed },
        },
      };
    });
    if (prevEntity?.script) {
      void executeUnifiedWidgetScript(
        nodeId,
        { kind: 'varsChanged', prevVars, changedKeys: [key] },
        nextEffectiveVars
      );
    }
  }, [executeUnifiedWidgetScript, pushHistory]);

  const handleDeleteDefaultVar = useCallback((nodeId: string, key: string) => {
    pushHistory();
    const prevEntity = effectiveNodesRef.current[nodeId];
    const prevVars = prevEntity ? { ...prevEntity.effectiveVars } : {};
    const nextEffectiveVars = { ...prevVars };
    delete nextEffectiveVars[key];

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
    setOverlay((prev) => {
      const curRv = prev.runtimeVars[nodeId];
      if (!curRv || !(key in curRv)) return prev;
      const nextRv = { ...curRv };
      delete nextRv[key];
      return {
        ...prev,
        runtimeVars: {
          ...prev.runtimeVars,
          [nodeId]: nextRv,
        },
      };
    });
    if (prevEntity?.script) {
      void executeUnifiedWidgetScript(
        nodeId,
        { kind: 'varsChanged', prevVars, changedKeys: [key] },
        nextEffectiveVars
      );
    }
  }, [executeUnifiedWidgetScript, pushHistory]);

  const handleDuplicateNode = useCallback((nodeId: string) => {
    const src = effectiveNodesRef.current[nodeId];
    if (!src) return;
    pushHistory();
    const newId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const existingBoxes: RectBox[] = Object.values(effectiveNodesRef.current).map((n) => ({
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
    }));
    const placed = findNonOverlappingPosition(
      { x: Math.round(src.x + src.width + 20), y: Math.round(src.y), width: src.width, height: src.height },
      existingBoxes,
      { gap: 20 }
    );
    const copy: BlueprintNode = {
      id: newId,
      x: placed.x,
      y: placed.y,
      width: src.width,
      height: src.height,
      title: `${src.title} (副本)`,
      body: src.body,
      category: src.category,
      color: src.color,
      script: src.script,
      inputPorts: src.inputPorts ? src.inputPorts.map((p) => ({ ...p })) : undefined,
      outputPorts: src.outputPorts ? src.outputPorts.map((p) => ({ ...p })) : undefined,
      defaultVars: (() => {
        const cloned = { ...src.effectiveVars };
        for (const k of ['x', 'y', 'pos', 'width', 'height', 'title', 'locked']) delete cloned[k];
        return cloned;
      })(),
      buttons: src.buttons ? src.buttons.map((b) => ({ ...b })) : [],
      rev: 1,
      cid: SELF_CID,
    };
    // 若原节点存在未信任脚本或按钮，副本同步继承锁定态，防止通过复制绕过审计门禁
    const inheritedUntrusted: string[] = [];
    if (untrustedScriptKeysRef.current.has(`${nodeId}:__script__`)) {
      inheritedUntrusted.push(`${newId}:__script__`);
    }
    for (const b of copy.buttons ?? []) {
      if (untrustedScriptKeysRef.current.has(`${nodeId}:${b.id}`)) {
        inheritedUntrusted.push(`${newId}:${b.id}`);
      }
    }
    if (inheritedUntrusted.length > 0) {
      const dupEntries = auditBlueprintScripts({
        version: baseRef.current.version,
        chunkSize: baseRef.current.chunkSize,
        nodes: { [newId]: copy },
        annotations: {},
        edges: {},
      }).filter((e) => inheritedUntrusted.includes(e.key));
      setUntrustedScriptKeys((prev) => {
        const next = new Set(prev);
        for (const k of inheritedUntrusted) next.add(k);
        return next;
      });
      if (dupEntries.length > 0) {
        setTrustModalState((prev) => {
          const byKey = new Map(prev.entries.map((e) => [e.key, e]));
          for (const e of dupEntries) byKey.set(e.key, e);
          return { ...prev, sourceLabel: prev.sourceLabel || `复制节点 (${copy.title})`, entries: Array.from(byKey.values()) };
        });
      }
    }
    setBase((prev) => ({
      ...prev,
      version: prev.version + 1,
      nodes: { ...prev.nodes, [newId]: copy },
    }));
    setInspectingNodeId(newId);
    setStatusLog(`已复制控件「${src.title}」至 (${placed.x}, ${placed.y})`);
  }, [pushHistory]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    pushHistory();
    const affectedTargets = new Set<string>();
    const nextEdgesSnap: Record<string, BlueprintEdge> = {};
    for (const [eid, edge] of Object.entries(edgesRef.current)) {
      if (edge.source === nodeId && edge.target !== nodeId) {
        affectedTargets.add(edge.target);
      }
      if (edge.source !== nodeId && edge.target !== nodeId) {
        nextEdgesSnap[eid] = edge;
      }
    }
    edgesRef.current = nextEdgesSnap;
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
    const refreshTargets = Array.from(affectedTargets).filter((tid) => Boolean(effectiveNodesRef.current[tid]?.script));
    if (refreshTargets.length > 0) {
      void Promise.all(
        refreshTargets.map((tid) =>
          executeUnifiedWidgetScript(tid, { kind: 'render' }, undefined, 1, undefined, nextEdgesSnap)
        )
      );
    }
    setOverlay((prev) => {
      const nextRuntime = { ...prev.runtimeVars };
      const nextPatches = { ...prev.nodePatches };
      delete nextRuntime[nodeId];
      delete nextPatches[nodeId];
      return { ...prev, runtimeVars: nextRuntime, nodePatches: nextPatches };
    });
    renderedScriptsRef.current.delete(nodeId);
    setScriptLogsByNode((prev) => {
      if (!prev[nodeId]) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    setInspectingNodeId((cur) => (cur === nodeId ? null : cur));
    setStatusLog('已删除控件及其关联连线');
  }, [pushHistory, executeUnifiedWidgetScript]);

  const handleSaveAsTemplate = useCallback((node: EffectiveBlueprintNode) => {
    const hasUntrusted =
      untrustedScriptKeysRef.current.has(`${node.id}:__script__`) ||
      (node.buttons ?? []).some((b) => untrustedScriptKeysRef.current.has(`${node.id}:${b.id}`));
    if (hasUntrusted) {
      setTrustModalState((s) => ({ ...s, open: true }));
      setStatusLog('该节点包含尚未信任的外部脚本，请先在审计弹窗中审阅后再存为模板');
      return;
    }
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
    pushHistory();
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
  }, [pushHistory]);

  const handleDeleteAnnotation = useCallback((id: string) => {
    pushHistory();
    setBase((prev) => {
      const nextAnns = { ...prev.annotations };
      delete nextAnns[id];
      return { ...prev, version: prev.version + 1, annotations: nextAnns };
    });
    setStatusLog('已删除背景注释');
  }, [pushHistory]);

  // 关键防闪烁同步：将可见 Chunk 的节点增量合入 rfNodes，严格保留每个已有节点的 measured / dragging / selected！
  useEffect(() => {
    if (lod === 'macro' || !chunkManagerRef.current) {
      setRfNodes((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const visibleChunks = chunkManagerRef.current.queryVisibleChunks(threeRingBounds.domPreloadBounds);
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
            onSliderChange: handleSliderChange,
            onSliderCommit: handleSliderCommit,
            onPad2DChange: handlePad2DChange,
            onPad2DCommit: handlePad2DCommit,
            onImageButtonTrigger: handleImageButtonTrigger,
            onBatchUpdateVars: handleBatchUpdateRuntimeVars,
            onScriptInputSubmit: handleScriptInputSubmit,
            onToggleLock: handleToggleLock,
            onResetLocal: handleResetNodeLocal,
            onEditTitle: handleEditTitle,
            onEditBody: handleEditBody,
            onResizeNode: handleResizeNode,
            onOpenInspector: (nid: string) => {
              if (typeof window !== 'undefined' && window.innerWidth < 768) {
                setTemplateDrawerOpen(false);
              }
              setInspectingNodeId(nid);
            },
            onDuplicateNode: handleDuplicateNode,
            onDeleteNode: handleDeleteNode,
            busyButtonKey,
            mediaActive: isBoxIntersecting(
              { minX: entity.x, minY: entity.y, maxX: entity.x + entity.width, maxY: entity.y + entity.height },
              threeRingBounds.mediaActiveBounds
            ),
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
    handleSliderChange,
    handleSliderCommit,
    handlePad2DChange,
    handlePad2DCommit,
    handleImageButtonTrigger,
    handleBatchUpdateRuntimeVars,
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

  const mountedWidgetIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const n of rfNodes) {
      if (!n.id.startsWith('ann-node:')) s.add(n.id);
    }
    return s;
  }, [rfNodes]);

  const rfEdges: Edge[] = useMemo(() => {
    if (lod === 'macro') return [];
    return filterVisibleEdges(base.edges, mountedWidgetIdSet).map((e) => {
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
  }, [lod, base.edges, mountedWidgetIdSet]);

  // 关键修复：onNodesChange 直接交给 applyNodeChanges 处理拖动/测量/选中，
  // 拖动过程中不触碰 overlay/base，只在松手（dragging === false）时一次性落盘，0 闪烁！
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const widgetFinals: Array<{ id: string; x: number; y: number }> = [];
    const annFinals: Array<{ id: string; x: number; y: number }> = [];
    const widgetRemovals: string[] = [];
    const annRemovals: string[] = [];
    const safeChanges: NodeChange[] = [];
    const curNodes = rfNodesRef.current;

    for (const ch of changes) {
      if (ch.type === 'remove') {
        if (ch.id.startsWith('ann-node:')) {
          annRemovals.push(ch.id.slice('ann-node:'.length));
          safeChanges.push(ch);
        } else if (!effectiveNodesRef.current[ch.id]?.locked) {
          widgetRemovals.push(ch.id);
          safeChanges.push(ch);
        }
        continue;
      }
      safeChanges.push(ch);
      if (ch.type === 'position') {
        if (ch.dragging === true) {
          draggingNodeIdsRef.current.add(ch.id);
        } else if (ch.dragging === false) {
          draggingNodeIdsRef.current.delete(ch.id);
          const node = curNodes.find((n) => n.id === ch.id);
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

    setRfNodes((prev) => applyNodeChanges(safeChanges, prev));

    for (const wid of widgetRemovals) {
      handleDeleteNode(wid);
    }
    for (const aid of annRemovals) {
      handleDeleteAnnotation(aid);
    }

    if (widgetFinals.length > 0 || annFinals.length > 0) {
      pushHistory();
    }

    if (widgetFinals.length > 0) {
      setOverlay((o) => {
        const nextPatches = { ...o.nodePatches };
        let nextRuntimeVars = o.runtimeVars;
        for (const u of widgetFinals) {
          nextPatches[u.id] = { ...(nextPatches[u.id] ?? {}), x: u.x, y: u.y };
          const cleanedRt = clearConflictingRuntimeVars(nextRuntimeVars[u.id], { x: u.x, y: u.y });
          if (cleanedRt !== nextRuntimeVars[u.id]) {
            if (nextRuntimeVars === o.runtimeVars) nextRuntimeVars = { ...o.runtimeVars };
            nextRuntimeVars[u.id] = cleanedRt!;
          }
        }
        return { ...o, runtimeVars: nextRuntimeVars, nodePatches: nextPatches };
      });
      setChunkSyncTick((t) => t + 1);
    }

    if (annFinals.length > 0) {
      setBase((b) => {
        const nextAnns = { ...b.annotations };
        for (const u of annFinals) {
          const cur = nextAnns[u.id];
          if (cur) nextAnns[u.id] = { ...cur, x: u.x, y: u.y, rev: cur.rev + 1, cid: SELF_CID };
        }
        return { ...b, version: b.version + 1, annotations: nextAnns };
      });
      setChunkSyncTick((t) => t + 1);
    }
  }, [pushHistory, handleDeleteNode, handleDeleteAnnotation]);

  // 由起点/终点控件自带脚本（onValidateConnect）决定是否放行连线；未注册钩子时默认允许自由拓扑（含环路）
  const validateConnectionByWidgets = useCallback(
    async (
      source: string,
      target: string,
      fromPort: string,
      toPort: string,
      activeEdgeMap: Record<string, BlueprintEdge>
    ): Promise<{ ok: boolean; reason?: string }> => {
      const dagInfo = validateDagConnection(Object.values(activeEdgeMap), source, target);
      const peers = buildPeerSnapshots(effectiveNodesRef.current);
      const edgesSnap = buildEdgeSnapshots(activeEdgeMap);
      const payload = {
        source,
        target,
        fromPort,
        toPort,
        fromNode: peers[source] ?? null,
        toNode: peers[target] ?? null,
        wouldCycle: !dagInfo.ok,
        cyclePath: dagInfo.cyclePath ?? [],
      };
      const candidates = Array.from(new Set([source, target])).filter((id) => {
        const node = effectiveNodesRef.current[id];
        return Boolean(node?.script) && !untrustedScriptKeysRef.current.has(`${id}:__script__`);
      });
      if (candidates.length === 0) return { ok: true };
      const results = await Promise.all(
        candidates.map((id) => {
          const node = effectiveNodesRef.current[id]!;
          return runInIsolatedWorker(node.script!, node.effectiveVars, {
            selfEntity: peers[id],
            peers,
            edges: edgesSnap,
            trigger: { kind: 'validateConnect', conn: payload },
          });
        })
      );
      for (const r of results) {
        // 校验直通：任一控件脚本判定拒绝即拦截
        if (r.ok && r.connectValidation && !r.connectValidation.ok) {
          return { ok: false, reason: r.connectValidation.reason };
        }
        // 校验脚本自身跑挂了（语法/超时/异常）不能当作「放行」——否则给校验脚本写个错就能静默绕过
        if (!r.ok) {
          return { ok: false, reason: `连线校验脚本执行失败，已阻止连线：${r.error || '未知错误'}` };
        }
      }
      return { ok: true };
    },
    [buildEdgeSnapshots, buildPeerSnapshots, untrustedScriptKeys]
  );

  validateConnectionByWidgetsRef.current = validateConnectionByWidgets;

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    const source = conn.source;
    const target = conn.target;
    const fromPort = conn.sourceHandle ?? 'out-1';
    const toPort = conn.targetHandle ?? 'in-1';
    void (async () => {
      const check = await validateConnectionByWidgets(source, target, fromPort, toPort, edgesRef.current);
      if (!check.ok) {
        setStatusLog(check.reason || '控件自定义校验拒绝了此连线');
        return;
      }
      pushHistory();
      const id = `edge-${source}-${target}-${Date.now()}`;
      const nextEdge: BlueprintEdge = {
        id,
        source,
        target,
        sourceHandle: conn.sourceHandle ?? undefined,
        targetHandle: conn.targetHandle ?? undefined,
        color: '#2563EB',
        rev: 1,
        cid: SELF_CID,
      };
      const nextEdges = { ...edgesRef.current, [id]: nextEdge };
      edgesRef.current = nextEdges;
      setBase((prev) => ({
        ...prev,
        version: prev.version + 1,
        edges: {
          ...prev.edges,
          [id]: nextEdge,
        },
      }));
      if (effectiveNodesRef.current[target]?.script) {
        void executeUnifiedWidgetScript(target, { kind: 'render' }, undefined, 1, undefined, nextEdges);
      }
      setStatusLog('已建立节点连线并同步下游数据通路（选中连线按 Delete 可删除）');
    })();
  }, [executeUnifiedWidgetScript, pushHistory, validateConnectionByWidgets]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length === 0) return;
    pushHistory();
    const affectedTargets = new Set<string>();
    const nextEdges = { ...edgesRef.current };
    for (const id of removed) {
      if (nextEdges[id]?.target) affectedTargets.add(nextEdges[id].target);
      delete nextEdges[id];
    }
    edgesRef.current = nextEdges;
    setBase((prev) => {
      const updated = { ...prev.edges };
      for (const id of removed) delete updated[id];
      return { ...prev, version: prev.version + 1, edges: updated };
    });
    for (const tid of affectedTargets) {
      if (effectiveNodesRef.current[tid]?.script) {
        void executeUnifiedWidgetScript(tid, { kind: 'render' }, undefined, 1, undefined, nextEdges);
      }
    }
    setStatusLog('已删除连线并刷新下游汇总');
  }, [executeUnifiedWidgetScript, pushHistory]);

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
      const publishedNodeIds = new Set(Object.keys(overlay.nodePatches));
      const publishedAnnIds = new Set(Object.keys(overlay.annotationOverrides ?? {}));
      const publishedOverlaySnapshot: LocalOverlayState = {
        runtimeVars: {},
        nodePatches: { ...overlay.nodePatches },
        annotationOverrides: { ...(overlay.annotationOverrides ?? {}) },
        trustedRemoteScripts: {},
      };
      setBase((prev) => applyOverlayToBase(prev, publishedOverlaySnapshot, SELF_CID));
      setOverlay((prev) => {
        const nextNodePatches = { ...prev.nodePatches };
        for (const nid of publishedNodeIds) {
          if (nextNodePatches[nid] === overlay.nodePatches[nid]) delete nextNodePatches[nid];
        }
        const nextAnnOverrides = { ...(prev.annotationOverrides ?? {}) };
        for (const aid of publishedAnnIds) {
          if (nextAnnOverrides[aid] === overlay.annotationOverrides?.[aid]) delete nextAnnOverrides[aid];
        }
        return { ...prev, nodePatches: nextNodePatches, annotationOverrides: nextAnnOverrides };
      });
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
            onClick={() =>
              setTemplateDrawerOpen((v) => {
                const next = !v;
                if (next && typeof window !== 'undefined' && window.innerWidth < 768) {
                  setInspectingNodeId(null);
                }
                return next;
              })
            }
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold text-white ${
              templateDrawerOpen ? 'bg-blue-700 hover:bg-blue-800' : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            模板库 ({allTemplates.length})
          </button>

          <button
            type="button"
            onClick={() =>
              handleCreateTemplateCenter(
                BUILTIN_TEMPLATES.find((t) => t.id === 'tpl-blank-widget') ?? BUILTIN_TEMPLATES[0]
              )
            }
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
            disabled={!historyMeta.canUndo}
            title="撤销 (Ctrl+Z)"
            onClick={handleUndo}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-35"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!historyMeta.canRedo}
            title="重做 (Ctrl+Y)"
            onClick={handleRedo}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-35"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            title="搜索节点或输入 Chunk 坐标跳转 (Ctrl+K)"
            onClick={() => setSearchOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            <Search className="h-3.5 w-3.5" />
            定位
          </button>

          <button
            type="button"
            title="复制当前分区坐标深链 (#chunk=cx,cy&zoom=z)"
            onClick={() => void handleCopyChunkLink()}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            <Link2 className="h-3.5 w-3.5" />
            坐标链
          </button>

          <button
            type="button"
            title="导出完整蓝图 JSON"
            onClick={handleExportJSON}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportJSONFile(f);
              e.target.value = '';
            }}
            className="hidden"
          />
          <button
            type="button"
            title="导入外部蓝图 JSON（自动触发脚本安全审计）"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            title="连接 WebSocket CRDT 多人协同房间"
            onClick={() => setRoomModalOpen(true)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${
              roomStatus === 'connected'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            {roomStatus === 'connected' ? '已联机' : '协同房间'}
          </button>

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
              pushHistory();
              renderedScriptsRef.current.clear();
              setScriptLogsByNode({});
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
        scriptLogs={inspectingNode ? (scriptLogsByNode[inspectingNode.id] ?? []) : []}
        onClearScriptLogs={handleClearScriptLogs}
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

      {/* 浮动通知位（仅在有通知消息时弹出，3.5 秒后自动收起） */}
      {statusLog && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-slate-200 bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur"
        >
          {statusLog}
        </div>
      )}

      {/* 上层 React Flow + 底层同步 Canvas 瓦片层 */}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        panOnDrag
        zoomOnPinch
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeDoubleClick={(_ev, edge) => {
          const initial = baseRef.current.edges[edge.id];
          if (!initial) return;
          const nextLabel = window.prompt('修改连线标签文字（留空清除）：', initial.label ?? '');
          if (nextLabel === null) return;
          pushHistory();
          setBase((prev) => {
            const cur = prev.edges[edge.id];
            if (!cur) return prev;
            return {
              ...prev,
              version: prev.version + 1,
              edges: {
                ...prev.edges,
                [edge.id]: { ...cur, label: nextLabel.trim() || undefined, rev: cur.rev + 1, cid: SELF_CID },
              },
            };
          });
        }}
        onPaneClick={() => setInspectingNodeId(null)}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
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
          edges={base.edges}
          lod={lod}
          showChunkGrid={showChunkGrid}
          annotationEditMode={annotationEditMode}
          renderVersion={renderVersion}
        />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      {/* Ctrl+K 全局搜索与 Chunk 坐标跳转弹窗 */}
      <SearchJumpModal
        open={searchOpen}
        nodes={effectiveNodes}
        annotations={effectiveAnnotations}
        onClose={() => setSearchOpen(false)}
        onJumpToPoint={(wx, wy, z, selectId) => {
          rf.setCenter(wx, wy, { zoom: z ?? 0.95, duration: 350 });
          if (selectId) setInspectingNodeId(selectId);
        }}
      />

      {/* 外部导入 / 远端同步脚本安全审计门禁 */}
      <ScriptTrustModal
        open={trustModalState.open}
        sourceLabel={trustModalState.sourceLabel}
        entries={trustModalState.entries}
        onKeepLocked={() => {
          setTrustModalState((s) => ({ ...s, open: false }));
          setStatusLog('外部脚本保持禁用锁定态（安全只读）');
        }}
        onTrustAll={() => {
          const approvedKeys = new Set(trustModalState.entries.map((e) => e.key));
          setUntrustedScriptKeys((prev) => {
            const next = new Set(prev);
            for (const k of approvedKeys) next.delete(k);
            return next;
          });
          setTrustModalState({ open: false, sourceLabel: '', entries: [] });
          renderedScriptsRef.current.clear();
          setChunkSyncTick((t) => t + 1);
          setStatusLog('已信任并启用已审阅的外部脚本');
        }}
      />

      {/* 多人实时协同房间（WebSocket + CRDT）弹窗 */}
      {roomModalOpen && (
        <div
          className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]"
          onClick={() => setRoomModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-slate-900">
              <Users className="h-5 w-5 text-teal-700" />
              <h3 className="text-sm font-bold">连接多人协同房间（CRDT）</h3>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              接入兼容 <code className="rounded bg-slate-100 px-1 font-mono">(rev, cid)</code> CRDT 协议的 WebSocket 房间服务（随 <code className="rounded bg-slate-100 px-1 font-mono">npm run dev</code> 一起启动，见 <code className="rounded bg-slate-100 px-1 font-mono">server/roomServer.ts</code>）。远端同步的新脚本会自动触发安全审计锁，绝不静默执行。
            </p>
            {!hasBackend() && (
              <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900">
                当前是<strong>纯静态演示模式</strong>：未配置 <code className="font-mono">VITE_BACKEND_WS_URL</code>，页面数据存在本机 IndexedDB，与他人不同步。要真正协同，请部署 <code className="font-mono">server/server.ts</code> 并重新构建时填入该地址。
              </p>
            )}
            <div className="mt-3 space-y-2.5 text-xs">
              <div>
                <label className="mb-1 block font-semibold text-slate-700">WebSocket 地址</label>
                <input
                  type="text"
                  value={roomWsUrl}
                  onChange={(e) => setRoomWsUrl(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-teal-600"
                />
              </div>
              <div>
                <label className="mb-1 block font-semibold text-slate-700">房间号</label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-teal-600"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              {roomStatus === 'connected' && (
                <button
                  type="button"
                  onClick={() => {
                    roomClientRef.current?.disconnect();
                    setRoomModalOpen(false);
                  }}
                  className="mr-auto rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
                >
                  断开连接
                </button>
              )}
              <button
                type="button"
                onClick={() => setRoomModalOpen(false)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConnectRoom}
                className="rounded-md bg-teal-700 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-teal-800"
              >
                加入房间
              </button>
            </div>
          </div>
        </div>
      )}

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
