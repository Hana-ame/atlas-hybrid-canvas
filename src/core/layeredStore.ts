/**
 * @file layeredStore.ts
 * @description 双层状态存储与合并引擎（权威底座 BaseBlueprint + 个人本地叠加层 LocalOverlayState）。
 * - 所有运行时 vars、个人拖拽/编辑补丁与脚本触发的背景覆盖均通过异步 IndexedDB 持久化；
 * - 合并时采用字段级稀疏覆盖，并自动丢弃后端已删除实体的孤儿缓存。
 */

import { idbGet, idbSet } from './idbStorage';
import { DEFAULT_ROOM_PATH, normalizeRoomPath } from './roomPath';
import type {
  BaseBlueprint,
  CanvasAnnotation,
  EffectiveBlueprintNode,
  LocalAnnotationOverride,
  LocalNodePatch,
  LocalOverlayState,
} from './types';

const OVERLAY_STORAGE_KEY = 'atlas-hybrid-local-overlay-v1';

export function getOverlayStorageKey(roomPath?: string): string {
  const normalized = normalizeRoomPath(roomPath);
  const isDefault = normalized === DEFAULT_ROOM_PATH || normalized === 'default';
  return isDefault ? OVERLAY_STORAGE_KEY : `${OVERLAY_STORAGE_KEY}:room:${normalized}`;
}

export function createEmptyOverlay(): LocalOverlayState {
  return {
    runtimeVars: {},
    nodePatches: {},
    annotationOverrides: {},
    edgeRuntime: {},
    trustedRemoteScripts: {},
  };
}

/**
 * 清理跨会话已失效的临时 blob: URL（如本地上传 PDF 或内置演示 PDF），避免刷新页面后 iframe 加载 404 死链。
 */
export function sanitizeEphemeralBlobVars(
  runtimeVars: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const cleaned: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, vars] of Object.entries(runtimeVars)) {
    if (!vars || typeof vars !== 'object') continue;
    const nextVars = { ...vars };
    if (typeof nextVars.pdfUrl === 'string' && nextVars.pdfUrl.startsWith('blob:')) {
      nextVars.pdfUrl = '';
      nextVars.pdfTotalPages = 0;
    }
    if (typeof nextVars.imageUrl === 'string' && nextVars.imageUrl.startsWith('blob:')) {
      nextVars.imageUrl = '';
    }
    if (typeof nextVars.videoUrl === 'string' && nextVars.videoUrl.startsWith('blob:')) {
      nextVars.videoUrl = '';
    }
    cleaned[nodeId] = nextVars;
  }
  return cleaned;
}

export async function loadLocalOverlay(roomPath?: string): Promise<LocalOverlayState> {
  try {
    const parsed = await idbGet<Partial<LocalOverlayState>>(getOverlayStorageKey(roomPath));
    if (!parsed) return createEmptyOverlay();
    return {
      runtimeVars: sanitizeEphemeralBlobVars(parsed.runtimeVars ?? {}),
      nodePatches: parsed.nodePatches ?? {},
      annotationOverrides: parsed.annotationOverrides ?? {},
      edgeRuntime: parsed.edgeRuntime ?? {},
      trustedRemoteScripts: parsed.trustedRemoteScripts ?? {},
    };
  } catch {
    return createEmptyOverlay();
  }
}

const SYNC_CHANNEL_NAME = 'atlas-hybrid-canvas-sync-v1';
const TAB_ID = `tab-${Math.random().toString(36).slice(2, 10)}`;
let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOverlay: LocalOverlayState | null = null;
let pendingRoomPath: string | undefined = undefined;
let syncChannel: BroadcastChannel | null = null;

function getSyncChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!syncChannel) {
    try {
      syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return syncChannel;
}

export async function saveLocalOverlay(overlay: LocalOverlayState, roomPath?: string): Promise<void> {
  const storageKey = getOverlayStorageKey(roomPath);
  await idbSet(storageKey, overlay);
  const ch = getSyncChannel();
  if (ch) {
    try {
      ch.postMessage({ type: 'overlay_updated', tabId: TAB_ID, storageKey, overlay });
    } catch {
      // 忽略克隆或关闭通道异常
    }
  }
}

/**
 * 防抖写盘（默认 300ms 合并高频输入/勾选），大幅降低 IndexedDB 写入放大。
 */
export function scheduleSaveLocalOverlay(
  overlay: LocalOverlayState,
  delayMs = 300,
  roomPath?: string
): void {
  pendingOverlay = overlay;
  pendingRoomPath = roomPath;
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    const toFlush = pendingOverlay;
    const targetRoom = pendingRoomPath;
    pendingOverlay = null;
    pendingRoomPath = undefined;
    if (toFlush) {
      void saveLocalOverlay(toFlush, targetRoom);
    }
  }, delayMs);
}

/** 收到同浏览器其他标签页的新快照时取消尚未落盘的旧防抖写盘，防止反写覆盖 */
export function cancelPendingLocalOverlaySave(): void {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  pendingOverlay = null;
}

/** 页面关闭前兜底立即刷盘 */
export function flushLocalOverlaySave(): void {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  const toFlush = pendingOverlay;
  const targetRoom = pendingRoomPath;
  pendingOverlay = null;
  pendingRoomPath = undefined;
  if (toFlush) {
    void saveLocalOverlay(toFlush, targetRoom);
  }
}

/**
 * 订阅同一浏览器其他标签页的本地叠加层变更，避免双开页签静默互相覆盖。
 */
export function subscribeCrossTabOverlay(
  onRemoteOverlay: (overlay: LocalOverlayState) => void,
  roomPath?: string
): () => void {
  const ch = getSyncChannel();
  if (!ch) return () => {};
  const expectedKey = getOverlayStorageKey(roomPath);
  const handler = (
    ev: MessageEvent<{ type?: string; tabId?: string; storageKey?: string; overlay?: LocalOverlayState }>
  ) => {
    const data = ev.data;
    if (!data || data.type !== 'overlay_updated' || data.tabId === TAB_ID || !data.overlay) return;
    if (data.storageKey !== expectedKey) return;
    onRemoteOverlay(data.overlay);
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}

/** 脚本可通过这些保留 vars 字段直接驱动控件的标题、类型、颜色、宽高与坐标 */
export const RESERVED_WIDGET_PROP_VARS = new Set([
  'contents',
  'title',
  'type',
  'category',
  'color',
  'width',
  'height',
  'pos',
  'x',
  'y',
  'locked',
  'input',
  'output',
]);

function toFiniteNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractVarDrivenProps(vars: Record<string, unknown>): Partial<LocalNodePatch> {
  const out: Partial<LocalNodePatch> = {};
  if (typeof vars.title === 'string') {
    out.title = vars.title;
  }
  const rawType = typeof vars.type === 'string' ? vars.type : typeof vars.category === 'string' ? vars.category : undefined;
  if (rawType !== undefined) {
    out.category = rawType;
  }
  if (typeof vars.color === 'string' && vars.color.trim()) {
    out.color = vars.color.trim();
  }
  const w = toFiniteNum(vars.width);
  if (w !== null) out.width = Math.max(180, Math.min(1400, Math.round(w)));
  const h = toFiniteNum(vars.height);
  if (h !== null) out.height = Math.max(100, Math.min(1200, Math.round(h)));
  if (vars.pos && typeof vars.pos === 'object') {
    if (Array.isArray(vars.pos) && vars.pos.length >= 2) {
      const px = toFiniteNum(vars.pos[0]);
      const py = toFiniteNum(vars.pos[1]);
      if (px !== null) out.x = Math.round(px);
      if (py !== null) out.y = Math.round(py);
    } else {
      const p = vars.pos as { x?: unknown; y?: unknown };
      const px = toFiniteNum(p.x);
      const py = toFiniteNum(p.y);
      if (px !== null) out.x = Math.round(px);
      if (py !== null) out.y = Math.round(py);
    }
  }
  const vx = toFiniteNum(vars.x);
  if (vx !== null) out.x = Math.round(vx);
  const vy = toFiniteNum(vars.y);
  if (vy !== null) out.y = Math.round(vy);
  if (typeof vars.locked === 'boolean') {
    out.locked = vars.locked;
  }
  return out;
}


/**
 * 当用户手动拖拽、缩放或编辑控件属性时，清理 runtimeVars 中冲突的形态/布局键，
 * 避免脚本旧值把手动修改弹回。
 */
export function clearConflictingRuntimeVars(
  rtVars: Record<string, unknown> | undefined,
  patch: Partial<LocalNodePatch>
): Record<string, unknown> | undefined {
  if (!rtVars) return rtVars;
  let changed = false;
  const next = { ...rtVars };
  if ('x' in patch || 'y' in patch) {
    if ('x' in next) { delete next.x; changed = true; }
    if ('y' in next) { delete next.y; changed = true; }
    if ('pos' in next) { delete next.pos; changed = true; }
  }
  if ('width' in patch && 'width' in next) { delete next.width; changed = true; }
  if ('height' in patch && 'height' in next) { delete next.height; changed = true; }
  if ('title' in patch && 'title' in next) { delete next.title; changed = true; }
  if ('category' in patch) {
    if ('type' in next) { delete next.type; changed = true; }
    if ('category' in next) { delete next.category; changed = true; }
  }
  if ('color' in patch && 'color' in next) { delete next.color; changed = true; }
  if ('locked' in patch && 'locked' in next) { delete next.locked; changed = true; }
  return changed ? next : rtVars;
}

/**
 * 从组件/检查器传入的节点补丁中提取受控字段，避免带入 runtime 派生字段。
 */
export function pickLocalNodePatch(patch: Partial<EffectiveBlueprintNode>): LocalNodePatch {
  const out: LocalNodePatch = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.body !== undefined) out.body = patch.body;
  if (patch.category !== undefined) out.category = patch.category;
  if (patch.color !== undefined) out.color = patch.color;
  if (patch.x !== undefined) out.x = patch.x;
  if (patch.y !== undefined) out.y = patch.y;
  if (patch.width !== undefined) out.width = patch.width;
  if (patch.height !== undefined) out.height = patch.height;
  if (patch.buttons !== undefined) out.buttons = patch.buttons;
  if (patch.script !== undefined) out.script = patch.script;
  if (patch.locked !== undefined) out.locked = patch.locked;
  if (patch.inputPorts !== undefined) out.inputPorts = patch.inputPorts;
  if (patch.outputPorts !== undefined) out.outputPorts = patch.outputPorts;
  return out;
}

/**
 * 将节点补丁直接写入权威底座 BaseBlueprint（用于协同房间联机编辑，以便通过 WS upsert_node 同步给 MCP 与协作者）。
 */
export function applyNodePatchesToBase(
  base: BaseBlueprint,
  patches: Record<string, LocalNodePatch>,
  selfCid: string
): BaseBlueprint {
  let nextNodes: Record<string, BaseBlueprint['nodes'][string]> | null = null;
  for (const [nodeId, patch] of Object.entries(patches)) {
    const cur = (nextNodes ?? base.nodes)[nodeId];
    if (!cur || Object.keys(patch).length === 0) continue;
    if (!nextNodes) nextNodes = { ...base.nodes };
    nextNodes[nodeId] = {
      ...cur,
      ...patch,
      rev: cur.rev + 1,
      cid: selfCid,
    };
  }
  if (!nextNodes) return base;
  return {
    ...base,
    version: base.version + 1,
    nodes: nextNodes,
  };
}

/**
 * 更新本地 overlay：
 * - `stripOverlay=false`（离线单机）：把补丁写入 overlay.nodePatches 并清理冲突 runtimeVars；
 * - `stripOverlay=true`（联机协同）：剥离已被权威底座吸收的同名覆盖键，防止本地旧补丁遮蔽远端/MCP 更新。
 */
export function applyNodePatchesToOverlay(
  overlay: LocalOverlayState,
  patches: Record<string, LocalNodePatch>,
  stripOverlay: boolean
): LocalOverlayState {
  let nextRuntimeVars = overlay.runtimeVars;
  let nextNodePatches = overlay.nodePatches;
  for (const [nodeId, patch] of Object.entries(patches)) {
    const patchKeys = Object.keys(patch);
    if (patchKeys.length === 0) continue;

    const cleanedRt = clearConflictingRuntimeVars(nextRuntimeVars[nodeId], patch);
    if (cleanedRt !== nextRuntimeVars[nodeId]) {
      if (nextRuntimeVars === overlay.runtimeVars) nextRuntimeVars = { ...overlay.runtimeVars };
      nextRuntimeVars[nodeId] = cleanedRt!;
    }

    if (stripOverlay) {
      const existingPatch = nextNodePatches[nodeId];
      if (!existingPatch) continue;
      let trimmed: LocalNodePatch | null = null;
      for (const key of patchKeys) {
        if (key in existingPatch) {
          if (!trimmed) trimmed = { ...existingPatch };
          delete trimmed[key as keyof LocalNodePatch];
        }
      }
      if (trimmed) {
        if (nextNodePatches === overlay.nodePatches) nextNodePatches = { ...overlay.nodePatches };
        if (Object.keys(trimmed).length === 0) {
          delete nextNodePatches[nodeId];
        } else {
          nextNodePatches[nodeId] = trimmed;
        }
      }
    } else {
      if (nextNodePatches === overlay.nodePatches) nextNodePatches = { ...overlay.nodePatches };
      nextNodePatches[nodeId] = {
        ...(nextNodePatches[nodeId] ?? {}),
        ...patch,
      };
    }
  }
  if (nextRuntimeVars === overlay.runtimeVars && nextNodePatches === overlay.nodePatches) {
    return overlay;
  }
  return {
    ...overlay,
    runtimeVars: nextRuntimeVars,
    nodePatches: nextNodePatches,
  };
}

/**
 * 统一分派交互式节点修改：联机写入 base（触发 WS 协同同步）并剥离遮蔽补丁，单机仅写入 overlay。
 */
export function applyInteractiveNodePatches(
  state: { base: BaseBlueprint; overlay: LocalOverlayState },
  patches: Record<string, LocalNodePatch>,
  options: { collaborative: boolean; selfCid: string }
): { base: BaseBlueprint; overlay: LocalOverlayState } {
  if (options.collaborative) {
    return {
      base: applyNodePatchesToBase(state.base, patches, options.selfCid),
      overlay: applyNodePatchesToOverlay(state.overlay, patches, true),
    };
  }
  return {
    base: state.base,
    overlay: applyNodePatchesToOverlay(state.overlay, patches, false),
  };
}

export function resolveEffectiveNodes(
  base: BaseBlueprint,
  overlay: LocalOverlayState
): Record<string, EffectiveBlueprintNode> {
  const result: Record<string, EffectiveBlueprintNode> = {};
  for (const [id, baseNode] of Object.entries(base.nodes)) {
    const patch: LocalNodePatch | undefined = overlay.nodePatches[id];
    const rtVars = overlay.runtimeVars[id];
    const hasLocalOverride = Boolean(patch && Object.keys(patch).length > 0);
    const hasRuntimeVars = Boolean(rtVars && Object.keys(rtVars).length > 0);
    const effectiveVars: Record<string, unknown> = {
      ...baseNode.defaultVars,
      ...(rtVars ?? {}),
    };
    const defaultVarDriven = extractVarDrivenProps(baseNode.defaultVars ?? {});
    const rtVarDriven = rtVars ? extractVarDrivenProps(rtVars) : {};

    result[id] = {
      ...baseNode,
      ...defaultVarDriven,
      ...(patch ?? {}),
      ...rtVarDriven,
      effectiveVars,
      hasLocalOverride,
      hasRuntimeVars,
    };
  }
  return result;
}

/**
 * 合并后端权威注释层与控件脚本动态触发的本地背景覆盖
 */
export function resolveEffectiveAnnotations(
  base: BaseBlueprint,
  overlay: LocalOverlayState
): Record<string, CanvasAnnotation> {
  const result: Record<string, CanvasAnnotation> = {};
  const overrides = overlay.annotationOverrides ?? {};
  for (const [id, ann] of Object.entries(base.annotations)) {
    const ov: LocalAnnotationOverride | undefined = overrides[id];
    result[id] = {
      ...ann,
      kind: ann.kind ?? 'text',
      height: ann.height ?? Math.max(48, ann.fontSize * 2.5),
      ...(ov ?? {}),
    };
  }
  return result;
}

export function applyOverlayToBase(
  base: BaseBlueprint,
  overlay: LocalOverlayState,
  selfCid: string
): BaseBlueprint {
  const nextNodes = { ...base.nodes };
  for (const [id, patch] of Object.entries(overlay.nodePatches)) {
    const existing = nextNodes[id];
    if (!existing) continue;
    nextNodes[id] = {
      ...existing,
      ...patch,
      rev: existing.rev + 1,
      cid: selfCid,
    };
  }
  const nextAnns = { ...base.annotations };
  for (const [id, ov] of Object.entries(overlay.annotationOverrides ?? {})) {
    const existing = nextAnns[id];
    if (!existing) continue;
    nextAnns[id] = {
      ...existing,
      ...ov,
      rev: existing.rev + 1,
      cid: selfCid,
    };
  }
  return {
    ...base,
    version: base.version + 1,
    nodes: nextNodes,
    annotations: nextAnns,
  };
}
