/**
 * @file useOverlaySync.ts
 * @description 本地叠加层防抖写盘（IndexedDB，300ms）与多标签页 BroadcastChannel 实时同步 Hook。
 * 使用单一 lastSyncedFingerprintRef 记录最新已同步/已落盘状态，既避免多条远端消息合批回环，
 * 也避免本地修改后再改回历史远端状态（S2 -> S3 -> S2）时被误判跳过写盘。
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  cancelPendingLocalOverlaySave,
  flushLocalOverlaySave,
  scheduleSaveLocalOverlay,
  subscribeCrossTabOverlay,
} from '../core/layeredStore';
import type { LocalOverlayState } from '../core/types';

function fingerprintOverlay(overlay: LocalOverlayState): string {
  try {
    return JSON.stringify(overlay);
  } catch {
    return '';
  }
}

export function useOverlaySync(
  overlay: LocalOverlayState,
  isReady: boolean,
  setOverlay: Dispatch<SetStateAction<LocalOverlayState>>,
  onRemoteNotice?: (msg: string) => void,
  onRemoteApplied?: () => void,
  roomPath?: string
) {
  const lastSyncedFingerprintRef = useRef<string>('');
  const hydratedInitRef = useRef(false);
  const prevRoomRef = useRef<string | undefined>(roomPath);

  // 防抖落盘（300ms 合并高频输入/勾选），切换房间或首次水合仅建立指纹基线，绝不向其他页签广播旧快照
  useEffect(() => {
    if (prevRoomRef.current !== roomPath) {
      flushLocalOverlaySave();
      prevRoomRef.current = roomPath;
      hydratedInitRef.current = false;
      lastSyncedFingerprintRef.current = '';
    }
    if (!isReady) return;
    const fp = fingerprintOverlay(overlay);
    if (!hydratedInitRef.current) {
      hydratedInitRef.current = true;
      lastSyncedFingerprintRef.current = fp;
      return;
    }
    if (fp && fp === lastSyncedFingerprintRef.current) {
      return;
    }
    lastSyncedFingerprintRef.current = fp;
    scheduleSaveLocalOverlay(overlay, 300, roomPath);
  }, [overlay, isReady, roomPath]);

  // 关闭/隐藏页签前兜底立即刷盘
  useEffect(() => {
    const onUnload = () => flushLocalOverlaySave();
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, []);

  // 订阅同浏览器其他标签页的本地更新，按最新指纹去重后合并
  useEffect(() => {
    if (!isReady) return;
    return subscribeCrossTabOverlay((remoteOverlay) => {
      const fp = fingerprintOverlay(remoteOverlay);
      if (fp && fp === lastSyncedFingerprintRef.current) return;
      cancelPendingLocalOverlaySave();
      lastSyncedFingerprintRef.current = fp;
      setOverlay(remoteOverlay);
      onRemoteApplied?.();
      onRemoteNotice?.('已自动同步同一浏览器其他标签页的本地修改');
    }, roomPath);
  }, [isReady, setOverlay, onRemoteNotice, onRemoteApplied, roomPath]);
}
