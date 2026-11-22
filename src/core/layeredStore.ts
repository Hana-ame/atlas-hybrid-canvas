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

export async function saveLocalOverlay(overlay: LocalOverlayState): Promise<void> {
  await idbSet(OVERLAY_STORAGE_KEY, overlay);
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

    result[id] = {
      ...baseNode,
      ...(patch ?? {}),
      effectiveVars: {
        ...baseNode.defaultVars,
        ...(rtVars ?? {}),
      },
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
