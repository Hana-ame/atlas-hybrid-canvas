/**
 * @file useBlueprintHistory.ts
 * @description 画布撤销/重做历史栈 Hook（最多保留 50 步深拷贝快照，回调引用稳定）。
 */

import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { BaseBlueprint, LocalOverlayState } from '../core/types';

export interface HistorySnapshot {
  base: BaseBlueprint;
  overlay: LocalOverlayState;
}

const MAX_HISTORY_STEPS = 50;

function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export function useBlueprintHistory(
  baseRef: MutableRefObject<BaseBlueprint>,
  overlayRef: MutableRefObject<LocalOverlayState>,
  setBase: Dispatch<SetStateAction<BaseBlueprint>>,
  setOverlay: Dispatch<SetStateAction<LocalOverlayState>>,
  onStatus: (msg: string) => void,
  onSyncTick: () => void
) {
  const pastRef = useRef<HistorySnapshot[]>([]);
  const futureRef = useRef<HistorySnapshot[]>([]);
  const [historyMeta, setHistoryMeta] = useState({ canUndo: false, canRedo: false });

  const pushHistory = useCallback(() => {
    pastRef.current.push({
      base: safeClone(baseRef.current),
      overlay: safeClone(overlayRef.current),
    });
    if (pastRef.current.length > MAX_HISTORY_STEPS) {
      pastRef.current.shift();
    }
    futureRef.current = [];
    setHistoryMeta({ canUndo: true, canRedo: false });
  }, [baseRef, overlayRef]);

  const handleUndo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push({
      base: safeClone(baseRef.current),
      overlay: safeClone(overlayRef.current),
    });
    setBase(prev.base);
    setOverlay(prev.overlay);
    onSyncTick();
    setHistoryMeta({
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
    });
    onStatus('已撤销上一步操作');
  }, [baseRef, overlayRef, setBase, setOverlay, onStatus, onSyncTick]);

  const handleRedo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push({
      base: safeClone(baseRef.current),
      overlay: safeClone(overlayRef.current),
    });
    setBase(next.base);
    setOverlay(next.overlay);
    onSyncTick();
    setHistoryMeta({
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
    });
    onStatus('已重做操作');
  }, [baseRef, overlayRef, setBase, setOverlay, onStatus, onSyncTick]);

  return {
    pushHistory,
    handleUndo,
    handleRedo,
    historyMeta,
  };
}
