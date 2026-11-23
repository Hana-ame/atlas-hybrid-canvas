/**
 * @file layeredStore.ts
 * @description 双层状态存储与合并引擎（权威底座 BaseBlueprint + 个人本地叠加层 LocalOverlayState）。
 * - 所有运行时 vars、个人拖拽/编辑补丁与脚本触发的背景覆盖均通过异步 IndexedDB 持久化；
 * - 合并时采用字段级稀疏覆盖，并自动丢弃后端已删除实体的孤儿缓存。
 */

import { idbGet, idbSet } from './idbStorage';
import type {
  BaseBlueprint,
  CanvasAnnotation,
  EffectiveBlueprintNode,
  LocalAnnotationOverride,
  LocalNodePatch,
  LocalOverlayState,
} from './types';

const OVERLAY_STORAGE_KEY = 'atlas-hybrid-local-overlay-v1';

export function createEmptyOverlay(): LocalOverlayState {
  return {
    runtimeVars: {},
    nodePatches: {},
    annotationOverrides: {},
    trustedRemoteScripts: {},
  };
}

export async function loadLocalOverlay(): Promise<LocalOverlayState> {
  try {
    const parsed = await idbGet<Partial<LocalOverlayState>>(OVERLAY_STORAGE_KEY);
    if (!parsed) return createEmptyOverlay();
    return {
      runtimeVars: parsed.runtimeVars ?? {},
      nodePatches: parsed.nodePatches ?? {},
      annotationOverrides: parsed.annotationOverrides ?? {},
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

export async function saveLocalOverlay(overlay: LocalOverlayState): Promise<void> {
  await idbSet(OVERLAY_STORAGE_KEY, overlay);
  const ch = getSyncChannel();
  if (ch) {
    try {
      ch.postMessage({ type: 'overlay_updated', tabId: TAB_ID, overlay });
    } catch {
      // 忽略克隆或关闭通道异常
    }
  }
}

/**
 * 防抖写盘（默认 300ms 合并高频输入/勾选），大幅降低 IndexedDB 写入放大。
 */
export function scheduleSaveLocalOverlay(overlay: LocalOverlayState, delayMs = 300): void {
  pendingOverlay = overlay;
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    const toFlush = pendingOverlay;
    pendingOverlay = null;
    if (toFlush) {
      void saveLocalOverlay(toFlush);
    }
  }, delayMs);
}

/** 页面关闭前兜底立即刷盘 */
export function flushLocalOverlaySave(): void {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  const toFlush = pendingOverlay;
  pendingOverlay = null;
  if (toFlush) {
    void saveLocalOverlay(toFlush);
  }
}

/**
 * 订阅同一浏览器其他标签页的本地叠加层变更，避免双开页签静默互相覆盖。
 */
export function subscribeCrossTabOverlay(onRemoteOverlay: (overlay: LocalOverlayState) => void): () => void {
  const ch = getSyncChannel();
  if (!ch) return () => {};
  const handler = (ev: MessageEvent<{ type?: string; tabId?: string; overlay?: LocalOverlayState }>) => {
    const data = ev.data;
    if (!data || data.type !== 'overlay_updated' || data.tabId === TAB_ID || !data.overlay) return;
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
]);

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
  if (vars.width !== undefined && Number.isFinite(Number(vars.width))) {
    out.width = Math.max(180, Math.min(1400, Math.round(Number(vars.width))));
  }
  if (vars.height !== undefined && Number.isFinite(Number(vars.height))) {
    out.height = Math.max(100, Math.min(1200, Math.round(Number(vars.height))));
  }
  if (vars.pos && typeof vars.pos === 'object') {
    if (Array.isArray(vars.pos) && vars.pos.length >= 2) {
      const px = Number(vars.pos[0]);
      const py = Number(vars.pos[1]);
      if (Number.isFinite(px)) out.x = Math.round(px);
      if (Number.isFinite(py)) out.y = Math.round(py);
    } else {
      const p = vars.pos as { x?: unknown; y?: unknown };
      if (p.x !== undefined && Number.isFinite(Number(p.x))) out.x = Math.round(Number(p.x));
      if (p.y !== undefined && Number.isFinite(Number(p.y))) out.y = Math.round(Number(p.y));
    }
  }
  if (vars.x !== undefined && Number.isFinite(Number(vars.x))) {
    out.x = Math.round(Number(vars.x));
  }
  if (vars.y !== undefined && Number.isFinite(Number(vars.y))) {
    out.y = Math.round(Number(vars.y));
  }
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
    const varDriven = extractVarDrivenProps(effectiveVars);

    result[id] = {
      ...baseNode,
      ...(patch ?? {}),
      ...varDriven,
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
