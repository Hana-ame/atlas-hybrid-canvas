/**
 * @file useOverlaySync.ts
 * @description 本地叠加层防抖写盘（IndexedDB，300ms）与多标签页 BroadcastChannel 实时同步 Hook。
 * 使用单一 lastSyncedFingerprintRef 记录最新已同步/已落盘状态，既避免多条远端消息合批回环，
 * 也避免本地修改后再改回历史远端状态（S2 -> S3 -> S2）时被误判跳过写盘。
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
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
  onRemoteNotice?: (msg: string) => void
) {
  const lastSyncedFingerprintRef = useRef<string>('');

  // 防抖落盘（300ms 合并高频输入/勾选），仅当内容与最新已同步指纹不同才写盘与广播
  useEffect(() => {
    if (!isReady) return;
    const fp = fingerprintOverlay(overlay);
    if (fp && fp === lastSyncedFingerprintRef.current) {
      return;
    }
    lastSyncedFingerprintRef.current = fp;
    scheduleSaveLocalOverlay(overlay, 300);
  }, [overlay, isReady]);

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
      lastSyncedFingerprintRef.current = fp;
      setOverlay(remoteOverlay);
      onRemoteNotice?.('已自动同步同一浏览器其他标签页的本地修改');
    });
  }, [isReady, setOverlay, onRemoteNotice]);
}
