/**
 * @file useBlueprintHistory.ts
 * @description 画布撤销/重做历史栈 Hook（内存 + IndexedDB 分级卸载）：
 * - L1 内存仅常驻最近 8 步快照，保证常规 Ctrl+Z 零延迟；
 * - 超出 8 步的历史（最多保留 50 步）自动溢出落盘至 IndexedDB `cache` 表，内存只留轻量 key，显著降低大画布堆内存占用。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { idbCacheClearPrefix, idbCacheDelete, idbCacheGet, idbCacheSet } from '../core/idbStorage';
import type { BaseBlueprint, LocalOverlayState } from '../core/types';

export interface HistorySnapshot {
  base: BaseBlueprint;
  overlay: LocalOverlayState;
}

const MAX_HISTORY_STEPS = 50;
const HOT_RAM_HISTORY_STEPS = 8;

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
  const sessionPrefixRef = useRef(`hist:${Date.now()}-${Math.random().toString(36).slice(2, 7)}:`);
  const seqRef = useRef(0);
  const pastHotRef = useRef<HistorySnapshot[]>([]);
  const pastColdKeysRef = useRef<string[]>([]);
  const futureRef = useRef<HistorySnapshot[]>([]);
  const [historyMeta, setHistoryMeta] = useState({ canUndo: false, canRedo: false });

  useEffect(() => {
    const prefix = sessionPrefixRef.current;
    const cleanup = () => {
      void idbCacheClearPrefix(prefix);
    };
    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      cleanup();
    };
  }, []);

  const syncMeta = useCallback(() => {
    setHistoryMeta({
      canUndo: pastHotRef.current.length > 0 || pastColdKeysRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
    });
  }, []);

  const pushHistory = useCallback(() => {
    pastHotRef.current.push({
      base: safeClone(baseRef.current),
      overlay: safeClone(overlayRef.current),
    });

    // 超出 L1 热内存上限时，将最老的一步溢出写入 IndexedDB，释放堆内存
    if (pastHotRef.current.length > HOT_RAM_HISTORY_STEPS) {
      const spill = pastHotRef.current.shift();
      if (spill) {
        seqRef.current += 1;
        const key = `${sessionPrefixRef.current}${seqRef.current}`;
        pastColdKeysRef.current.push(key);
        void idbCacheSet(key, spill, MAX_HISTORY_STEPS + 20);
      }
    }

    // 总深度超过 50 步时淘汰最老的冷快照
    while (pastHotRef.current.length + pastColdKeysRef.current.length > MAX_HISTORY_STEPS) {
      const dropKey = pastColdKeysRef.current.shift();
      if (dropKey) {
        void idbCacheDelete(dropKey);
      } else {
        pastHotRef.current.shift();
      }
    }

    futureRef.current = [];
    syncMeta();
  }, [baseRef, overlayRef, syncMeta]);

  const applySnapshot = useCallback(
    (snap: HistorySnapshot, statusMsg: string) => {
      baseRef.current = snap.base;
      overlayRef.current = snap.overlay;
      setBase(snap.base);
      setOverlay(snap.overlay);
      onSyncTick();
      syncMeta();
      onStatus(statusMsg);
    },
    [baseRef, overlayRef, setBase, setOverlay, onSyncTick, syncMeta, onStatus]
  );

  const handleUndo = useCallback(() => {
    const hotPrev = pastHotRef.current.pop();
    if (hotPrev) {
      futureRef.current.push({
        base: safeClone(baseRef.current),
        overlay: safeClone(overlayRef.current),
      });
      if (futureRef.current.length > HOT_RAM_HISTORY_STEPS) {
        futureRef.current.shift();
      }
      applySnapshot(hotPrev, '已撤销上一步操作');
      return;
    }

    const coldKey = pastColdKeysRef.current.pop();
    if (!coldKey) return;
    syncMeta();
    void idbCacheGet<HistorySnapshot>(coldKey).then((coldPrev) => {
      void idbCacheDelete(coldKey);
      if (!coldPrev) {
        syncMeta();
        return;
      }
      futureRef.current.push({
        base: safeClone(baseRef.current),
        overlay: safeClone(overlayRef.current),
      });
      if (futureRef.current.length > HOT_RAM_HISTORY_STEPS) {
        futureRef.current.shift();
      }
      applySnapshot(coldPrev, '已从 IndexedDB 历史缓存撤销上一步');
    });
  }, [baseRef, overlayRef, applySnapshot, syncMeta]);

  const handleRedo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastHotRef.current.push({
      base: safeClone(baseRef.current),
      overlay: safeClone(overlayRef.current),
    });
    if (pastHotRef.current.length > HOT_RAM_HISTORY_STEPS) {
      const spill = pastHotRef.current.shift();
      if (spill) {
        seqRef.current += 1;
        const key = `${sessionPrefixRef.current}${seqRef.current}`;
        pastColdKeysRef.current.push(key);
        void idbCacheSet(key, spill, MAX_HISTORY_STEPS + 20);
      }
    }
    applySnapshot(next, '已重做操作');
  }, [baseRef, overlayRef, applySnapshot]);

  return {
    pushHistory,
    handleUndo,
    handleRedo,
    historyMeta,
  };
}
