/**
 * @file useOverlaySync.ts
 * @description 本地叠加层防抖写盘（IndexedDB）与多标签页 BroadcastChannel 实时同步 Hook。
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  flushLocalOverlaySave,
  scheduleSaveLocalOverlay,
  subscribeCrossTabOverlay,
} from '../core/layeredStore';
import type { LocalOverlayState } from '../core/types';

export function useOverlaySync(
  overlay: LocalOverlayState,
  isReady: boolean,
  setOverlay: Dispatch<SetStateAction<LocalOverlayState>>,
  onRemoteNotice?: (msg: string) => void
) {
  const skipNextSaveRef = useRef(false);

  // 防抖落盘（300ms 合并高频打字/勾选）
  useEffect(() => {
    if (!isReady) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
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

  // 订阅同浏览器其他标签页的本地更新，避免静默互相覆盖
  useEffect(() => {
    if (!isReady) return;
    return subscribeCrossTabOverlay((remoteOverlay) => {
      skipNextSaveRef.current = true;
      setOverlay(remoteOverlay);
      onRemoteNotice?.('已自动同步同一浏览器其他标签页的本地修改');
    });
  }, [isReady, setOverlay, onRemoteNotice]);
}
