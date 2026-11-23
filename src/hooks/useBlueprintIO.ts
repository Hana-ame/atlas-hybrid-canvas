/**
 * @file useBlueprintIO.ts
 * @description 蓝图 JSON 导出、外部导入（含脚本安全审计门禁）与 Chunk 深链复制 Hook。
 */

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { applyOverlayToBase, createEmptyOverlay } from '../core/layeredStore';
import { auditBlueprintScripts } from '../core/scriptAudit';
import type { BaseBlueprint, BlueprintNode, LocalOverlayState } from '../core/types';
import type { ScriptConsoleEntry } from '../components/NodeInspectorPanel';
import type { TrustModalState } from './useRoomCollaboration';

function toFiniteNum(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface UseBlueprintIOOptions {
  selfCid: string;
  baseRef: MutableRefObject<BaseBlueprint>;
  overlayRef: MutableRefObject<LocalOverlayState>;
  rfStore: { getState: () => { transform: [number, number, number]; width: number; height: number } };
  pushHistory: () => void;
  setBase: Dispatch<SetStateAction<BaseBlueprint>>;
  setOverlay: Dispatch<SetStateAction<LocalOverlayState>>;
  setStatusLog: Dispatch<SetStateAction<string>>;
  setChunkSyncTick: Dispatch<SetStateAction<number>>;
  setScriptLogsByNode: Dispatch<SetStateAction<Record<string, ScriptConsoleEntry[]>>>;
  setUntrustedScriptKeys: Dispatch<SetStateAction<Set<string>>>;
  setTrustModalState: Dispatch<SetStateAction<TrustModalState>>;
  renderedScriptsRef: MutableRefObject<Set<string>>;
}

export function useBlueprintIO({
  selfCid,
  baseRef,
  overlayRef,
  rfStore,
  pushHistory,
  setBase,
  setOverlay,
  setStatusLog,
  setChunkSyncTick,
  setScriptLogsByNode,
  setUntrustedScriptKeys,
  setTrustModalState,
  renderedScriptsRef,
}: UseBlueprintIOOptions) {
  const handleCopyChunkLink = useCallback(async () => {
    const { transform, width, height } = rfStore.getState();
    const [tx, ty, zoom] = transform;
    const centerWorldX = (width * 0.5 - tx) / zoom;
    const centerWorldY = (height * 0.5 - ty) / zoom;
    const cx = Math.floor(centerWorldX / 512);
    const cy = Math.floor(centerWorldY / 512);
    const hash = `#chunk=${cx},${cy}&zoom=${zoom.toFixed(2)}`;
    try {
      window.history.replaceState(null, '', hash);
    } catch {
      // about:blank / srcdoc / file:// 下禁止 replaceState，安全降级
    }
    const baseOrigin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : '';
    const fullUrl = `${baseOrigin}${window.location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setStatusLog(`已复制分区坐标链接：Chunk (${cx}, ${cy}) @ ${Math.round(zoom * 100)}%`);
    } catch {
      setStatusLog(`已更新地址栏坐标：${hash}`);
    }
  }, [rfStore, setStatusLog]);

  const handleExportJSON = useCallback(() => {
    const merged = applyOverlayToBase(baseRef.current, overlayRef.current, selfCid);
    const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atlas-blueprint-v${merged.version}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatusLog('已导出完整蓝图 JSON 文件');
  }, [baseRef, overlayRef, selfCid, setStatusLog]);

  const handleImportJSONFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || '')) as BaseBlueprint;
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            !parsed.nodes ||
            typeof parsed.nodes !== 'object' ||
            Array.isArray(parsed.nodes)
          ) {
            setStatusLog('导入失败：JSON 缺少有效的 nodes 对象');
            return;
          }
          const safeNodes: Record<string, BlueprintNode> = {};
          for (const [nid, rawNode] of Object.entries(parsed.nodes as Record<string, Partial<BlueprintNode>>)) {
            if (!rawNode || typeof rawNode !== 'object') continue;
            safeNodes[nid] = {
              ...rawNode,
              id: typeof rawNode.id === 'string' && rawNode.id ? rawNode.id : nid,
              x: toFiniteNum(rawNode.x) ?? 0,
              y: toFiniteNum(rawNode.y) ?? 0,
              width: Math.max(180, toFiniteNum(rawNode.width) ?? 280),
              height: Math.max(100, toFiniteNum(rawNode.height) ?? 180),
              title: typeof rawNode.title === 'string' ? rawNode.title : '未命名控件',
              body: typeof rawNode.body === 'string' ? rawNode.body : '',
              color: typeof rawNode.color === 'string' ? rawNode.color : '#2563EB',
              defaultVars:
                rawNode.defaultVars && typeof rawNode.defaultVars === 'object' ? rawNode.defaultVars : {},
              rev: Number.isFinite(Number(rawNode.rev)) ? Number(rawNode.rev) : 1,
              cid: typeof rawNode.cid === 'string' ? rawNode.cid : 'imported',
            };
          }
          pushHistory();
          const normalized: BaseBlueprint = {
            version: Number(parsed.version) || 1,
            chunkSize: Number(parsed.chunkSize) || 512,
            nodes: safeNodes,
            annotations:
              parsed.annotations && typeof parsed.annotations === 'object' && !Array.isArray(parsed.annotations)
                ? parsed.annotations
                : {},
            edges:
              parsed.edges && typeof parsed.edges === 'object' && !Array.isArray(parsed.edges)
                ? parsed.edges
                : {},
          };
          const entries = auditBlueprintScripts(normalized);
          renderedScriptsRef.current.clear();
          setScriptLogsByNode({});
          setBase(normalized);
          setOverlay(createEmptyOverlay());
          setChunkSyncTick((t) => t + 1);
          if (entries.length > 0) {
            setUntrustedScriptKeys(new Set(entries.map((e) => e.key)));
            setTrustModalState({ open: true, sourceLabel: file.name, entries });
            setStatusLog(`已导入「${file.name}」，检测到 ${entries.length} 条外部脚本已默认锁定等待审阅`);
          } else {
            setUntrustedScriptKeys(new Set());
            setStatusLog(`已安全导入蓝图「${file.name}」`);
          }
        } catch {
          setStatusLog('导入失败：文件不是合法的 JSON 格式');
        }
      };
      reader.readAsText(file);
    },
    [
      pushHistory,
      renderedScriptsRef,
      setBase,
      setChunkSyncTick,
      setOverlay,
      setScriptLogsByNode,
      setStatusLog,
      setTrustModalState,
      setUntrustedScriptKeys,
    ]
  );

  return { handleCopyChunkLink, handleExportJSON, handleImportJSONFile };
}
