/**
 * @file useBlueprintHistory.ts
 * @description 画布撤销/重做历史栈 Hook（默认保留 50 步深拷贝快照，支持 Ctrl+Z / Ctrl+Y / Cmd+Shift+Z）。
 */

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { BaseBlueprint, LocalOverlayState } from '../core/types';

export interface HistorySnapshot {
  base: BaseBlueprint;
  overlay: LocalOverlayState;
}

const MAX_HISTORY_STEPS = 50;

export function useBlueprintHistory(
  base: BaseBlueprint,
  overlay: LocalOverlayState,
  setBase: Dispatch<SetStateAction<BaseBlueprint>>,
  setOverlay: Dispatch<SetStateAction<LocalOverlayState>>,
  onStatus: (msg: string) => void,
  onSyncTick: () => void
) {
  const pastRef = useRef<HistorySnapshot[]>([]);
  const futureRef = useRef<HistorySnapshot[]>([]);
  const [, setHistoryTick] = useState(0);

  const pushHistory = useCallback(
    (snapBase?: BaseBlueprint, snapOverlay?: LocalOverlayState) => {
      const b = snapBase ?? base;
      const o = snapOverlay ?? overlay;
      pastRef.current = [...pastRef.current.slice(-(MAX_HISTORY_STEPS - 1)), {
        base: structuredClone(b),
        overlay: structuredClone(o),
      }];
      futureRef.current = [];
      setHistoryTick((t) => t + 1);
    },
    [base, overlay]
  );

  const handleUndo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) {
      onStatus('已到达最早一步，无可撤销操作');
      return;
    }
    futureRef.current.push({
      base: structuredClone(base),
      overlay: structuredClone(overlay),
    });
    setBase(prev.base);
    setOverlay(prev.overlay);
    onSyncTick();
    setHistoryTick((t) => t + 1);
    onStatus('已撤销上一步操作 (Ctrl+Z)');
  }, [base, overlay, setBase, setOverlay, onStatus, onSyncTick]);

  const handleRedo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) {
      onStatus('无可重做操作');
      return;
    }
    pastRef.current.push({
      base: structuredClone(base),
      overlay: structuredClone(overlay),
    });
    setBase(next.base);
    setOverlay(next.overlay);
    onSyncTick();
    setHistoryTick((t) => t + 1);
    onStatus('已重做操作 (Ctrl+Y)');
  }, [base, overlay, setBase, setOverlay, onStatus, onSyncTick]);

  return {
    pushHistory,
    handleUndo,
    handleRedo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}
