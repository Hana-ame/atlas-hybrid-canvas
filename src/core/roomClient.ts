import { appendProxyTokenQuery } from './apiClient';
/**
 * @file roomClient.ts
 * @description 多人实时协同房间客户端（WebSocket + 字段级 (rev, cid) CRDT + 指数退避自动重连 + 离线缓冲队列）。
 * - 负责将本地结构变更增量推送到房间，并按 mergeRecordFieldsLWW 合并远端变更；
 * - 断线后自动指数退避重连（500ms..15s），期间本地编辑暂存队列，重连成功后自动补发；
 * - 任何来自远端的脚本修改均会标记为待审阅，由前端接入 ScriptTrustModal 门禁，防止协同注入攻击。
 */
import { mergeRecordFieldsLWW } from './crdt';
import type { BaseBlueprint, BlueprintEdge, BlueprintNode, CanvasAnnotation } from './types';

export type RoomStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type RoomWireMessage =
  | { t: 'hello'; room: string; cid: string }
  | { t: 'state'; blueprint: BaseBlueprint }
  | { t: 'upsert_node'; node: BlueprintNode }
  | { t: 'delete_node'; id: string }
  | { t: 'upsert_ann'; annotation: CanvasAnnotation }
  | { t: 'delete_ann'; id: string }
  | { t: 'upsert_edge'; edge: BlueprintEdge }
  | { t: 'delete_edge'; id: string };

const MAX_OFFLINE_QUEUE = 200;
const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 8;

export class CollaborativeRoomClient {
  private ws: WebSocket | null = null;
  readonly cid: string;
  private onStatus: (status: RoomStatus, info?: string) => void;
  private onRemoteMessage: (msg: RoomWireMessage) => void;
  private lastWsUrl = '';
  private lastRoomName = '';
  private manualDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineQueue: RoomWireMessage[] = [];

  constructor(
    cid: string,
    onStatus: (status: RoomStatus, info?: string) => void,
    onRemoteMessage: (msg: RoomWireMessage) => void
  ) {
    this.cid = cid;
    this.onStatus = onStatus;
    this.onRemoteMessage = onRemoteMessage;
  }

  connect(wsUrl: string, roomName: string): void {
    this.clearReconnectTimer();
    this.closeSocketOnly();
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = INITIAL_RECONNECT_MS;
    this.lastWsUrl = wsUrl.trim();
    this.lastRoomName = roomName;
    this.openConnection(false);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocketOnly(): void {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        // ignore
      }
    }
  }

  private openConnection(isReconnect: boolean): void {
    const trimmed = this.lastWsUrl;
    const roomName = this.lastRoomName;
    if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) {
      this.onStatus('error', '房间地址需以 ws:// 或 wss:// 开头');
      return;
    }

    this.onStatus(
      isReconnect ? 'reconnecting' : 'connecting',
      isReconnect ? `正在重连房间 ${roomName}（第 ${this.reconnectAttempts} 次）…` : `正在连接 ${roomName}…`
    );

    try {
      const sep = trimmed.includes('?') ? '&' : '?';
      const fullUrl = `${trimmed}${sep}room=${encodeURIComponent(roomName)}&cid=${encodeURIComponent(this.cid)}`;
      const ws = new WebSocket(appendProxyTokenQuery(fullUrl));
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.reconnectAttempts = 0;
        this.reconnectDelay = INITIAL_RECONNECT_MS;
        this.onStatus('connected', `已加入房间 ${roomName}`);
        this.sendImmediate(ws, { t: 'hello', room: roomName, cid: this.cid });
        this.flushOfflineQueue(ws);
      };

      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(String(ev.data)) as RoomWireMessage;
          if (msg && typeof msg === 'object' && typeof msg.t === 'string') {
            this.onRemoteMessage(msg);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.onStatus('error', 'WebSocket 房间连接异常，准备重试…');
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.manualDisconnect) {
          this.onStatus('disconnected', '已断开房间连接');
          return;
        }
        this.scheduleReconnect();
      };
    } catch {
      this.onStatus('error', '无法初始化 WebSocket 连接');
    }
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.reconnectTimer || !this.lastWsUrl) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.onStatus('error', `房间重连已达上限（${MAX_RECONNECT_ATTEMPTS} 次），请手动重连`);
      return;
    }
    this.reconnectAttempts += 1;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    this.onStatus('reconnecting', `连接断开，${Math.round(delay / 100) / 10}s 后自动重连…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect) {
        this.openConnection(true);
      }
    }, delay);
  }

  private sendImmediate(ws: WebSocket, msg: RoomWireMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private flushOfflineQueue(ws: WebSocket): void {
    if (this.offlineQueue.length === 0 || ws.readyState !== WebSocket.OPEN) return;
    const pending = this.offlineQueue.splice(0, this.offlineQueue.length);
    for (const m of pending) {
      ws.send(JSON.stringify(m));
    }
  }

  send(msg: RoomWireMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (!this.manualDisconnect && msg.t !== 'hello') {
      if (this.offlineQueue.length >= MAX_OFFLINE_QUEUE) {
        this.offlineQueue.shift();
      }
      this.offlineQueue.push(msg);
    }
  }

  getQueuedCount(): number {
    return this.offlineQueue.length;
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.offlineQueue = [];
    this.closeSocketOnly();
    this.onStatus('disconnected');
  }
}

/** 按字段级 (rev, cid) CRDT 规则将远端 Blueprint 合并进本地 BaseBlueprint */
export function mergeRemoteBlueprintCRDT(local: BaseBlueprint, remote: BaseBlueprint): BaseBlueprint {
  const nodes = { ...local.nodes };
  for (const [id, rNode] of Object.entries(remote.nodes || {})) {
    const res = mergeRecordFieldsLWW(nodes[id], rNode);
    if (res.changed) nodes[id] = res.merged;
  }
  const annotations = { ...local.annotations };
  for (const [id, rAnn] of Object.entries(remote.annotations || {})) {
    const res = mergeRecordFieldsLWW(annotations[id], rAnn);
    if (res.changed) annotations[id] = res.merged;
  }
  const edges = { ...local.edges };
  for (const [id, rEdge] of Object.entries(remote.edges || {})) {
    const res = mergeRecordFieldsLWW(edges[id], rEdge);
    if (res.changed) edges[id] = res.merged;
  }
  return {
    ...local,
    version: Math.max(local.version, remote.version || 1) + 1,
    nodes,
    annotations,
    edges,
  };
}
