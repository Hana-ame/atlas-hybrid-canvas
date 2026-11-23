/**
 * @file useOverlaySync.ts
 * @description 本地叠加层防抖写盘（IndexedDB，300ms）与多标签页 BroadcastChannel 实时同步 Hook。
 * 采用内容指纹比对防回环，避免多条远端消息合并进同一渲染批次时产生 A→B→A 广播抖动。
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
  const lastRemoteFingerprintRef = useRef<string>('');
  const lastSavedFingerprintRef = useRef<string>('');

  // 防抖落盘（300ms 合并高频输入/勾选），命中远端指纹时直接跳过不回广播
  useEffect(() => {
    if (!isReady) return;
    const fp = fingerprintOverlay(overlay);
    if (fp && (fp === lastRemoteFingerprintRef.current || fp === lastSavedFingerprintRef.current)) {
      return;
    }
    lastSavedFingerprintRef.current = fp;
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

  // 订阅同浏览器其他标签页的本地更新，按内容指纹去重后合并
  useEffect(() => {
    if (!isReady) return;
    return subscribeCrossTabOverlay((remoteOverlay) => {
      const fp = fingerprintOverlay(remoteOverlay);
      if (fp && fp === lastSavedFingerprintRef.current) return;
      lastRemoteFingerprintRef.current = fp;
      lastSavedFingerprintRef.current = fp;
      setOverlay(remoteOverlay);
      onRemoteNotice?.('已自动同步同一浏览器其他标签页的本地修改');
    });
  }, [isReady, setOverlay, onRemoteNotice]);
}
