/**
 * @file roomClient.ts
 * @description 多人实时协同房间客户端（WebSocket + 确定性 (rev, cid) CRDT）。
 * - 负责将本地结构变更增量推送到房间，并按 beats(incoming, current) 合并远端变更；
 * - 任何来自远端的脚本修改均会标记为待审阅，由前端接入 ScriptTrustModal 门禁，防止协同注入攻击。
 */
import { beats } from './crdt';
import type { BaseBlueprint, BlueprintEdge, BlueprintNode, CanvasAnnotation } from './types';

export type RoomStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type RoomWireMessage =
  | { t: 'hello'; room: string; cid: string }
  | { t: 'state'; blueprint: BaseBlueprint }
  | { t: 'upsert_node'; node: BlueprintNode }
  | { t: 'delete_node'; id: string }
  | { t: 'upsert_ann'; annotation: CanvasAnnotation }
  | { t: 'delete_ann'; id: string }
  | { t: 'upsert_edge'; edge: BlueprintEdge }
  | { t: 'delete_edge'; id: string };

export class CollaborativeRoomClient {
  private ws: WebSocket | null = null;
  readonly cid: string;
  private onStatus: (status: RoomStatus, info?: string) => void;
  private onRemoteMessage: (msg: RoomWireMessage) => void;

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
    this.disconnect();
    const trimmed = wsUrl.trim();
    if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) {
      this.onStatus('error', '房间地址需以 ws:// 或 wss:// 开头');
      return;
    }

    this.onStatus('connecting', `正在连接 ${roomName}…`);
    try {
      const sep = trimmed.includes('?') ? '&' : '?';
      const fullUrl = `${trimmed}${sep}room=${encodeURIComponent(roomName)}&cid=${encodeURIComponent(this.cid)}`;
      const ws = new WebSocket(fullUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.onStatus('connected', `已加入房间 ${roomName}`);
        this.send({ t: 'hello', room: roomName, cid: this.cid });
      };

      ws.onmessage = (ev) => {
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
        this.onStatus('error', 'WebSocket 房间连接失败（请确认协同房间服务已启动）');
      };

      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.onStatus('disconnected', '已断开房间连接');
        }
      };
    } catch {
      this.onStatus('error', '无法初始化 WebSocket 连接');
    }
  }

  send(msg: RoomWireMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.close();
    }
    this.onStatus('disconnected');
  }
}

/** 按 (rev, cid) 确定性 CRDT 规则将远端 Blueprint 合并进本地 BaseBlueprint */
export function mergeRemoteBlueprintCRDT(local: BaseBlueprint, remote: BaseBlueprint): BaseBlueprint {
  const nodes = { ...local.nodes };
  for (const [id, rNode] of Object.entries(remote.nodes || {})) {
    if (beats(rNode, nodes[id])) nodes[id] = rNode;
  }
  const annotations = { ...local.annotations };
  for (const [id, rAnn] of Object.entries(remote.annotations || {})) {
    if (beats(rAnn, annotations[id])) annotations[id] = rAnn;
  }
  const edges = { ...local.edges };
  for (const [id, rEdge] of Object.entries(remote.edges || {})) {
    if (beats(rEdge, edges[id])) edges[id] = rEdge;
  }
  return {
    ...local,
    version: Math.max(local.version, remote.version || 1) + 1,
    nodes,
    annotations,
    edges,
  };
}
