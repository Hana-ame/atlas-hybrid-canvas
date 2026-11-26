/**
 * @file useRoomCollaboration.ts
 * @description 多人实时协同房间 Hook（WebSocket 连接管理、CRDT 增量收发、远端脚本安全审计拦截）。
 * 从 App.tsx 抽离以降低顶层组件复杂度。
 */

import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { beats, computeRecordDiff, mergeRecordFieldsLWW } from '../core/crdt';
import { CollaborativeRoomClient, mergeRemoteBlueprintCRDT, type RoomStatus } from '../core/roomClient';
import { auditBlueprintScripts, type ScriptAuditEntry } from '../core/scriptAudit';
import type { BaseBlueprint, LocalOverlayState } from '../core/types';
import type { ScriptConsoleEntry } from '../components/NodeInspectorPanel';

export interface TrustModalState {
  open: boolean;
  sourceLabel: string;
  entries: ScriptAuditEntry[];
}

export interface UseRoomCollaborationOptions {
  selfCid: string;
  base: BaseBlueprint;
  baseRef: MutableRefObject<BaseBlueprint>;
  roomWsUrl: string;
  roomName: string;
  roomNameRef: MutableRefObject<string>;
  roomStatus: RoomStatus;
  setRoomStatus: Dispatch<SetStateAction<RoomStatus>>;
  setRoomModalOpen: Dispatch<SetStateAction<boolean>>;
  setBase: Dispatch<SetStateAction<BaseBlueprint>>;
  setOverlay: Dispatch<SetStateAction<LocalOverlayState>>;
  setStatusLog: Dispatch<SetStateAction<string>>;
  setChunkSyncTick: Dispatch<SetStateAction<number>>;
  setUntrustedScriptKeys: Dispatch<SetStateAction<Set<string>>>;
  setTrustModalState: Dispatch<SetStateAction<TrustModalState>>;
  setScriptLogsByNode: Dispatch<SetStateAction<Record<string, ScriptConsoleEntry[]>>>;
  setInspectingNodeId: Dispatch<SetStateAction<string | null>>;
  renderedScriptsRef: MutableRefObject<Set<string>>;
}

export function useRoomCollaboration({
  selfCid,
  base,
  baseRef,
  roomWsUrl,
  roomName,
  roomNameRef,
  roomStatus,
  setRoomStatus,
  setRoomModalOpen,
  setBase,
  setOverlay,
  setStatusLog,
  setChunkSyncTick,
  setUntrustedScriptKeys,
  setTrustModalState,
  setScriptLogsByNode,
  setInspectingNodeId,
  renderedScriptsRef,
}: UseRoomCollaborationOptions) {
  const roomClientRef = useRef<CollaborativeRoomClient | null>(null);
  const prevSyncedBaseRef = useRef<BaseBlueprint | null>(null);
  const maxSyncedMetaRef = useRef<Map<string, { id: string; rev: number; cid: string }>>(new Map());

  const handleConnectRoom = useCallback(() => {
    if (!roomWsUrl.trim()) {
      setStatusLog('协同不可用：当前是纯静态演示模式，未配置 VITE_BACKEND_WS_URL');
      return;
    }
    if (!roomClientRef.current) {
      roomClientRef.current = new CollaborativeRoomClient(
        selfCid,
        (st, info) => {
          setRoomStatus(st);
          if (info) setStatusLog(info);
        },
        (msg) => {
          const mergeTrustEntries = (label: string, newEntries: ScriptAuditEntry[]) => {
            if (newEntries.length === 0) return;
            setUntrustedScriptKeys((prev) => {
              const next = new Set(prev);
              for (const e of newEntries) next.add(e.key);
              return next;
            });
            setTrustModalState((prev) => {
              const byKey = new Map(prev.entries.map((e) => [e.key, e]));
              for (const e of newEntries) byKey.set(e.key, e);
              return { open: true, sourceLabel: label, entries: Array.from(byKey.values()) };
            });
          };
          const recordSyncedMeta = (kind: string, rec: { id: string; rev: number; cid: string }) => {
            const k = `${kind}:${rec.id}`;
            const cur = maxSyncedMetaRef.current.get(k);
            if (!cur || beats(rec, cur)) {
              maxSyncedMetaRef.current.set(k, { id: rec.id, rev: Number(rec.rev) || 0, cid: String(rec.cid || '') });
            }
          };
          const beatsLocalAndSynced = (
            kind: string,
            incoming: { id: string; rev: number; cid: string },
            cur: { id: string; rev: number; cid: string } | undefined
          ) => {
            if (cur && !beats(incoming, cur)) return false;
            const synced = maxSyncedMetaRef.current.get(`${kind}:${incoming.id}`);
            if (synced && !beats(incoming, synced)) return false;
            return true;
          };

          if (msg.t === 'state' && msg.blueprint) {
            const entries = auditBlueprintScripts(msg.blueprint);
            mergeTrustEntries(`协同房间 ${roomNameRef.current}`, entries);
            if (msg.replace) {
              maxSyncedMetaRef.current.clear();
            }
            for (const n of Object.values(msg.blueprint.nodes ?? {})) recordSyncedMeta('node', n);
            for (const a of Object.values(msg.blueprint.annotations ?? {})) recordSyncedMeta('ann', a);
            for (const e of Object.values(msg.blueprint.edges ?? {})) recordSyncedMeta('edge', e);
            setBase((prev) => {
              if (msg.replace) {
                const replaced: BaseBlueprint = {
                  version: (prev.version || 0) + 1,
                  chunkSize: msg.blueprint.chunkSize ?? prev.chunkSize,
                  nodes: msg.blueprint.nodes ?? {},
                  annotations: msg.blueprint.annotations ?? {},
                  edges: msg.blueprint.edges ?? {},
                };
                prevSyncedBaseRef.current = replaced;
                return replaced;
              }
              const merged = mergeRemoteBlueprintCRDT(prev, msg.blueprint);
              if (prevSyncedBaseRef.current) {
                prevSyncedBaseRef.current = mergeRemoteBlueprintCRDT(prevSyncedBaseRef.current, msg.blueprint);
              }
              return merged;
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }

          if (msg.t === 'upsert_node' && msg.node) {
            const remoteNode = msg.node;
            const curLocal = baseRef.current.nodes[remoteNode.id];
            const probe = mergeRecordFieldsLWW(curLocal, remoteNode);
            if (probe.changed || beatsLocalAndSynced('node', remoteNode, curLocal)) {
              recordSyncedMeta('node', remoteNode);
              const singleBp: BaseBlueprint = {
                version: baseRef.current.version,
                chunkSize: baseRef.current.chunkSize,
                nodes: { [probe.merged.id]: probe.merged },
                annotations: {},
                edges: {},
              };
              const entries = auditBlueprintScripts(singleBp);
              const scriptChanged =
                !curLocal ||
                curLocal.script !== probe.merged.script ||
                JSON.stringify(curLocal.buttons ?? []) !== JSON.stringify(probe.merged.buttons ?? []);
              if (entries.length > 0 && scriptChanged) {
                mergeTrustEntries(`协同远端更新 (${probe.merged.title})`, entries);
              }
              setBase((prev) => {
                const cur = prev.nodes[remoteNode.id];
                const res = mergeRecordFieldsLWW(cur, remoteNode);
                if (!res.changed) return prev;
                if (prevSyncedBaseRef.current) {
                  prevSyncedBaseRef.current = {
                    ...prevSyncedBaseRef.current,
                    nodes: { ...prevSyncedBaseRef.current.nodes, [remoteNode.id]: res.merged },
                  };
                }
                return {
                  ...prev,
                  version: prev.version + 1,
                  nodes: { ...prev.nodes, [remoteNode.id]: res.merged },
                };
              });
              setChunkSyncTick((t) => t + 1);
            }
            return;
          }

          if (msg.t === 'delete_node' && msg.id) {
            const delId = msg.id;
            setBase((prev) => {
              if (!prev.nodes[delId]) return prev;
              const nextNodes = { ...prev.nodes };
              delete nextNodes[delId];
              const nextEdges: typeof prev.edges = {};
              for (const [eid, e] of Object.entries(prev.edges)) {
                if (e.source !== delId && e.target !== delId) nextEdges[eid] = e;
              }
              if (prevSyncedBaseRef.current) {
                const sn = { ...prevSyncedBaseRef.current.nodes };
                delete sn[delId];
                const se: typeof prev.edges = {};
                for (const [eid, e] of Object.entries(prevSyncedBaseRef.current.edges)) {
                  if (e.source !== delId && e.target !== delId) se[eid] = e;
                }
                prevSyncedBaseRef.current = { ...prevSyncedBaseRef.current, nodes: sn, edges: se };
              }
              return { ...prev, version: prev.version + 1, nodes: nextNodes, edges: nextEdges };
            });
            setOverlay((prev) => {
              if (!prev.runtimeVars[delId] && !prev.nodePatches[delId]) return prev;
              const nextRv = { ...prev.runtimeVars };
              const nextPatches = { ...prev.nodePatches };
              delete nextRv[delId];
              delete nextPatches[delId];
              return { ...prev, runtimeVars: nextRv, nodePatches: nextPatches };
            });
            renderedScriptsRef.current.delete(delId);
            setScriptLogsByNode((prev) => {
              if (!prev[delId]) return prev;
              const next = { ...prev };
              delete next[delId];
              return next;
            });
            setInspectingNodeId((cur) => (cur === delId ? null : cur));
            setChunkSyncTick((t) => t + 1);
            return;
          }

          if (msg.t === 'upsert_ann' && msg.annotation) {
            const remoteAnn = msg.annotation;
            const probe = mergeRecordFieldsLWW(baseRef.current.annotations[remoteAnn.id], remoteAnn);
            if (!probe.changed && !beatsLocalAndSynced('ann', remoteAnn, baseRef.current.annotations[remoteAnn.id])) return;
            recordSyncedMeta('ann', remoteAnn);
            setBase((prev) => {
              const cur = prev.annotations[remoteAnn.id];
              const res = mergeRecordFieldsLWW(cur, remoteAnn);
              if (!res.changed) return prev;
              if (prevSyncedBaseRef.current) {
                prevSyncedBaseRef.current = {
                  ...prevSyncedBaseRef.current,
                  annotations: { ...prevSyncedBaseRef.current.annotations, [remoteAnn.id]: res.merged },
                };
              }
              return { ...prev, version: prev.version + 1, annotations: { ...prev.annotations, [remoteAnn.id]: res.merged } };
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }

          if (msg.t === 'delete_ann' && msg.id) {
            const delId = msg.id;
            setBase((prev) => {
              if (!prev.annotations[delId]) return prev;
              const nextAnns = { ...prev.annotations };
              delete nextAnns[delId];
              if (prevSyncedBaseRef.current) {
                const sa = { ...prevSyncedBaseRef.current.annotations };
                delete sa[delId];
                prevSyncedBaseRef.current = { ...prevSyncedBaseRef.current, annotations: sa };
              }
              return { ...prev, version: prev.version + 1, annotations: nextAnns };
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }

          if (msg.t === 'upsert_edge' && msg.edge) {
            const remoteEdge = msg.edge;
            const probe = mergeRecordFieldsLWW(baseRef.current.edges[remoteEdge.id], remoteEdge);
            if (!probe.changed && !beatsLocalAndSynced('edge', remoteEdge, baseRef.current.edges[remoteEdge.id])) return;
            recordSyncedMeta('edge', remoteEdge);
            setBase((prev) => {
              const cur = prev.edges[remoteEdge.id];
              const res = mergeRecordFieldsLWW(cur, remoteEdge);
              if (!res.changed) return prev;
              if (prevSyncedBaseRef.current) {
                prevSyncedBaseRef.current = {
                  ...prevSyncedBaseRef.current,
                  edges: { ...prevSyncedBaseRef.current.edges, [remoteEdge.id]: res.merged },
                };
              }
              return { ...prev, version: prev.version + 1, edges: { ...prev.edges, [remoteEdge.id]: res.merged } };
            });
            setChunkSyncTick((t) => t + 1);
            return;
          }

          if (msg.t === 'delete_edge' && msg.id) {
            const delId = msg.id;
            setBase((prev) => {
              if (!prev.edges[delId]) return prev;
              const nextEdges = { ...prev.edges };
              delete nextEdges[delId];
              if (prevSyncedBaseRef.current) {
                const se = { ...prevSyncedBaseRef.current.edges };
                delete se[delId];
                prevSyncedBaseRef.current = { ...prevSyncedBaseRef.current, edges: se };
              }
              return { ...prev, version: prev.version + 1, edges: nextEdges };
            });
            setChunkSyncTick((t) => t + 1);
          }
        }
      );
    }
    maxSyncedMetaRef.current.clear();
    roomClientRef.current.connect(roomWsUrl, roomName);
    setRoomModalOpen(false);
  }, [
    selfCid,
    roomWsUrl,
    roomName,
    roomNameRef,
    baseRef,
    renderedScriptsRef,
    setRoomStatus,
    setStatusLog,
    setUntrustedScriptKeys,
    setTrustModalState,
    setBase,
    setChunkSyncTick,
    setOverlay,
    setScriptLogsByNode,
    setInspectingNodeId,
    setRoomModalOpen,
  ]);

  useEffect(() => {
    return () => {
      roomClientRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (roomStatus !== 'connected' || !roomClientRef.current) {
      if (roomStatus === 'disconnected') maxSyncedMetaRef.current.clear();
      prevSyncedBaseRef.current = base;
      return;
    }
    const prev = prevSyncedBaseRef.current;
    prevSyncedBaseRef.current = base;
    if (!prev) {
      roomClientRef.current.send({ t: 'state', blueprint: base });
      return;
    }
    const getMinRev = (kind: string) => (id: string) => maxSyncedMetaRef.current.get(`${kind}:${id}`)?.rev ?? 0;
    const trackSent = <T extends { id: string; rev: number; cid: string }>(kind: string, rec: T): T => {
      maxSyncedMetaRef.current.set(`${kind}:${rec.id}`, { id: rec.id, rev: Number(rec.rev) || 0, cid: selfCid });
      return rec;
    };
    const nodeDiff = computeRecordDiff(prev.nodes, base.nodes, selfCid, getMinRev('node'));
    for (const node of nodeDiff.upserts) roomClientRef.current.send({ t: 'upsert_node', node: trackSent('node', node) });
    for (const id of nodeDiff.deletes) roomClientRef.current.send({ t: 'delete_node', id });
    const annDiff = computeRecordDiff(prev.annotations, base.annotations, selfCid, getMinRev('ann'));
    for (const annotation of annDiff.upserts) roomClientRef.current.send({ t: 'upsert_ann', annotation: trackSent('ann', annotation) });
    for (const id of annDiff.deletes) roomClientRef.current.send({ t: 'delete_ann', id });
    const edgeDiff = computeRecordDiff(prev.edges, base.edges, selfCid, getMinRev('edge'));
    for (const edge of edgeDiff.upserts) roomClientRef.current.send({ t: 'upsert_edge', edge: trackSent('edge', edge) });
    for (const id of edgeDiff.deletes) roomClientRef.current.send({ t: 'delete_edge', id });
  }, [base, roomStatus, selfCid]);

  return { roomClientRef, handleConnectRoom };
}
