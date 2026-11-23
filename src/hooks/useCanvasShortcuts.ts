/**
 * @file useCanvasShortcuts.ts
 * @description 画布全局快捷键 Hook（Ctrl/Cmd+K 搜索定位、Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Y / Shift+Z 重做）。
 * 输入框或文本域聚焦时自动放行浏览器原生文本撤销。
 */

import { useEffect } from 'react';

export interface CanvasShortcutsOptions {
  onToggleSearch: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

export function useCanvasShortcuts({
  onToggleSearch,
  onUndo,
  onRedo,
}: CanvasShortcutsOptions): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        onToggleSearch();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        onUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        onRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggleSearch, onUndo, onRedo]);
}
