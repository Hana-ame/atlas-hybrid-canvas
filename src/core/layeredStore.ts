import type {
  BaseBlueprint,
  EffectiveBlueprintNode,
  LocalNodePatch,
  LocalOverlayState,
} from './types';

const OVERLAY_STORAGE_KEY = 'atlas-hybrid-local-overlay-v1';

export function createEmptyOverlay(): LocalOverlayState {
  return {
    runtimeVars: {},
    nodePatches: {},
    trustedRemoteScripts: {},
  };
}

export function loadLocalOverlay(): LocalOverlayState {
  try {
    const raw = localStorage.getItem(OVERLAY_STORAGE_KEY);
    if (!raw) return createEmptyOverlay();
    const parsed = JSON.parse(raw) as Partial<LocalOverlayState>;
    return {
      runtimeVars: parsed.runtimeVars ?? {},
      nodePatches: parsed.nodePatches ?? {},
      trustedRemoteScripts: parsed.trustedRemoteScripts ?? {},
    };
  } catch {
    return createEmptyOverlay();
  }
}

export function saveLocalOverlay(overlay: LocalOverlayState): void {
  try {
    localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(overlay));
  } catch {
    // ignore storage quota errors in demo
  }
}

/**
 * 合并权威底座（Base）与个人本地叠加层（Local Overlay）
 * 自动清理后端已删除节点的孤儿本地缓存
 */
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
 * 将用户的字段级本地补丁合并回权威底座（显式“发布到后端”时调用）
 */
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
  return {
    ...base,
    version: base.version + 1,
    nodes: nextNodes,
  };
}
