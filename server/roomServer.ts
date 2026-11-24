/**
 * @file roomServer.ts
 * @description 内建 WebSocket 协同房间服务（替代原 room-go/）。
 *
 * 设计取舍：
 * - 与 roomClient.ts 的 RoomWireMessage 协议逐字对齐，前端无需任何改动；
 * - CRDT 裁决规则（rev 优先、平局比 cid）与 src/core/crdt.ts 的 beats() 以及
 *   原 room-go/store.go 完全一致，保证三种实现可以互操作；
 * - 广播时先在锁内拷贝目标列表、解锁后再逐个发送。慢客户端只会拖慢自己那一轮，
 *   不会把整个房间的锁占住（这是原 Go 实现做对的地方，照搬）；
 * - 新成员加入时补发全量 state 快照，缺席期间错过的增量由快照覆盖。
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RoomBlueprintStore } from './fileStore';
import { extractRoomPathFromWsPathname } from '../src/core/roomPath';
import { mergeRecordFieldsLWW } from '../src/core/crdt';
import { extractWsSubprotocolToken, parseCookieValue } from './authSession';
import { decodeBinaryRpcFrame, encodeBinaryRpcFrame } from '../src/core/rpcBinaryFrame';

/**
 * RPC 帧：让前端把一次 HTTP 调用（也就是原来被 mockApi 在浏览器里就地处理的那些
 * /api/* 请求）整包发到服务端，由服务端复用同一套 Express 路由处理，再把结果原样
 * 送回。`id` 用于配对，客户端可以并发多个在途请求。
 *
 * 这里只做传输，不解释业务语义——请求进 Express，响应出 Express，中间不加工，
 * 因此服务端已有的鉴权、限流、白名单、SSRF 防护全部照旧生效。
 */
export type RpcRequestFrame = {
  t: 'rpc_req';
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  rawBody?: Uint8Array;
  bodyEncoding?: 'text' | 'base64' | 'binary';
  clientIp?: string;
};

export type RpcResponseFrame = {
  t: 'rpc_res';
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody?: Uint8Array;
  bodyEncoding: 'text' | 'base64' | 'binary';
};

/** 与 roomClient.ts 保持一致的消息形状。服务端只做校验与中继，不解释业务字段。 */
type WireMessage =
  | { t: 'hello'; room: string; cid: string }
  | { t: 'state'; blueprint: Record<string, unknown> }
  | { t: 'upsert_node'; node: VersionedRecord }
  | { t: 'delete_node'; id: string }
  | { t: 'upsert_ann'; annotation: VersionedRecord }
  | { t: 'delete_ann'; id: string }
  | { t: 'upsert_edge'; edge: VersionedRecord }
  | { t: 'delete_edge'; id: string }
  | { t: 'rtc_offer'; from?: string; to: string; sdp: unknown }
  | { t: 'rtc_answer'; from?: string; to: string; sdp: unknown }
  | { t: 'rtc_ice'; from?: string; to: string; candidate: unknown }
  | RpcRequestFrame;

interface VersionedRecord {
  id?: unknown;
  rev?: unknown;
  cid?: unknown;
  [k: string]: unknown;
}

/** 三大集合，与 BaseBlueprint 的 nodes / annotations / edges 对应。 */
const COLLECTIONS = ['nodes', 'annotations', 'edges'] as const;
type Collection = (typeof COLLECTIONS)[number];

interface Member {
  socket: WebSocket;
  cid: string;
  alive: boolean;
}

interface Room {
  name: string;
  members: Map<WebSocket, Member>;
}

// ── 容量上限：全部显式设限，避免无界增长（原 Go 实现缺这一层） ────────────
const MAX_ROOMS = 64;
const MAX_MEMBERS_PER_ROOM = 32;
const MAX_FRAME_BYTES = 4 * 1024 * 1024; // 协同房间单帧 4MB，够放下整份 blueprint
const MAX_RPC_WS_PAYLOAD_BYTES = 72 * 1024 * 1024; // WS RPC 允许承载 50MB PDF base64 编码帧
const MAX_RECORDS_PER_COLLECTION = 5000; // 每个集合最多 5000 条，超出拒绝写入
const MAX_STRING_FIELD = 512 * 1024; // 单字段（正文/脚本）上限
const HEARTBEAT_MS = 30_000;
/** 空房间保留时长：最后一人离开后 30 分钟无人回来才回收，避免"人都走了数据就没了"。 */
const ROOM_IDLE_TTL_MS = 30 * 60_000;

/**
 * LWW 裁决，与 crdt.ts 的 beats() 逐行等价：
 * rev 大的赢；rev 相同则 cid 字典序大的赢。这保证三个实现裁决结果一致。
 */
function beats(incoming: VersionedRecord, current: VersionedRecord | undefined): boolean {
  if (!current) return true;
  const ar = Number(incoming.rev) || 0;
  const cr = Number(current.rev) || 0;
  if (ar !== cr) return ar > cr;
  return String(incoming.cid || '') > String(current.cid || '');
}

function isVersionedRecord(value: unknown): value is VersionedRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as VersionedRecord;
  if (typeof rec.id !== 'string' || rec.id.length === 0 || rec.id.length > 200) return false;
  if (typeof rec.rev !== 'number' || !Number.isFinite(rec.rev)) return false;
  if (typeof rec.cid !== 'string' || rec.cid.length > 200) return false;
  // 单字段体积上限：防止一个畸形消息塞进几百 MB 正文把进程撑爆。
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.length > MAX_STRING_FIELD) return false;
  }
  return true;
}

/** 房间状态：三个按 id 索引的 CRDT 集合。 */
class RoomState {
  private readonly data: Record<Collection, Map<string, VersionedRecord>> = {
    nodes: new Map(),
    annotations: new Map(),
    edges: new Map(),
  };

  upsert(kind: Collection, rec: VersionedRecord): boolean {
    const bucket = this.data[kind];
    const id = rec.id as string;
    const existing = bucket.get(id);
    if (!existing) {
      if (bucket.size >= MAX_RECORDS_PER_COLLECTION) return false;
      bucket.set(id, rec);
      return true;
    }
    // 直接复用客户端同源的 mergeRecordFieldsLWW，彻底消除两端字段级 CRDT 裁决分歧
    const res = mergeRecordFieldsLWW(existing as unknown as { id: string; rev: number; cid: string; fieldRevs?: Record<string, { rev: number; cid: string }> }, rec as unknown as { id: string; rev: number; cid: string; fieldRevs?: Record<string, { rev: number; cid: string }> });
    if (!res.changed) return false;
    bucket.set(id, res.merged as VersionedRecord);
    return true;
  }

  remove(kind: Collection, id: string): boolean {
    // delete 消息不带 rev/cid，无法与写入做同一套裁决。这里直接删：
    // 删一个已被更高 rev 覆盖的记录，语义上是"用户仍然想删它"，删掉比留着更符合意图，
    // 且后续 upsert 会用更高 rev 把它重新加回来，不会误伤正常编辑。
    return this.data[kind].delete(id);
  }

  replaceSnapshot(bp: Record<string, unknown>): void {
    for (const kind of COLLECTIONS) {
      this.data[kind].clear();
      const col = bp[kind];
      if (!col || typeof col !== 'object') continue;
      for (const rec of Object.values(col as Record<string, unknown>)) {
        if (isVersionedRecord(rec)) this.upsert(kind, rec);
      }
    }
  }

  snapshot(): Record<Collection, Record<string, VersionedRecord>> {
    const out = { nodes: {}, annotations: {}, edges: {} } as Record<
      Collection,
      Record<string, VersionedRecord>
    >;
    for (const kind of COLLECTIONS) {
      for (const [id, rec] of this.data[kind]) out[kind][id] = rec;
    }
    return out;
  }

  get size(): number {
    return this.data.nodes.size + this.data.annotations.size + this.data.edges.size;
  }
}

export interface RoomServerHandle {
  close: () => Promise<void>;
  stats: () => { rooms: number; members: number };
  syncPublishedBlueprint: (roomName: string, blueprint: unknown) => void;
}

/**
 * RPC 处理器：把一帧 rpc_req 交给真正的后端处理，返回结果帧。
 *
 * 由调用方注入（server.ts 里接到 Express 上），这样 roomServer.ts 不依赖 Express，
 * 也便于单测里塞一个假处理器。
 */
export type RpcHandler = (frame: RpcRequestFrame) => Promise<RpcResponseFrame>;

/**
 * 把 WebSocket 房间服务挂到已有的 http.Server 上（与 Express 共用端口）。
 * 默认路径 /ws，正好是前端 App.tsx 里 ws://localhost:8787/ws 的默认值。
 *
 * rpcHandler 可选：不传则 rpc_req 一律回 501，房间功能不受影响。
 */
export function attachRoomServer(
  httpServer: HttpServer,
  wsPath = '/ws',
  rpcHandler?: RpcHandler,
  _persistDir?: string,
  verifyToken?: (token: string) => boolean,
  getRoomStore?: (roomName: string) => RoomBlueprintStore
): RoomServerHandle {
  const rooms = new Map<string, Room>();
  const states = new Map<string, RoomState>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_WS_PAYLOAD_BYTES,
    handleProtocols: (protocols) => (protocols.has('atlas-v1') ? 'atlas-v1' : false),
  });

  function send(socket: WebSocket, msg: unknown): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** 广播：锁内只拷目标列表，解锁后逐个发送。慢客户端只影响自己。 */
  function broadcast(room: Room, msg: unknown, except?: WebSocket): void {
    const targets: WebSocket[] = [];
    for (const member of room.members.values()) {
      if (member.socket !== except) targets.push(member.socket);
    }
    for (const socket of targets) {
      if (!send(socket, msg)) {
        // 发送失败即视为死连接，走 leave 广播 peer_left 并记录空闲时间后再终结连接。
        leave(room, socket);
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 房间状态比连接活得久：最后一个人离开时不立刻销毁，否则房间里已积累的数据全丢，
  // 下一个人进来是空的。改为记一个空闲时间戳，由清扫任务在超过 ROOM_IDLE_TTL_MS 后回收。
  const idleSince = new Map<string, number>();
  const hydratedRooms = new Set<string>();
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedulePersistRoom = (roomName: string) => {
    if (!getRoomStore || roomName === '__rpc__') return;
    const prev = persistTimers.get(roomName);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      persistTimers.delete(roomName);
      const st = states.get(roomName);
      if (st) {
        const snap = st.snapshot();
        const store = getRoomStore(roomName);
        void store
          .writeBlueprint(snap)
          .then(() => store.recordHistory('collab', { summary: '协同增量自动保存', blueprint: snap }))
          .catch(() => {});
      }
    }, 600);
    timer.unref?.();
    persistTimers.set(roomName, timer);
  };

  function leave(room: Room, socket: WebSocket): void {
    const member = room.members.get(socket);
    if (!member) return;
    room.members.delete(socket);
    broadcast(room, { t: 'peer_left', cid: member.cid });
    if (room.members.size === 0) idleSince.set(room.name, Date.now());
  }

  function join(roomName: string, socket: WebSocket, cid: string): Room | null {
    let room = rooms.get(roomName);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return null;
      room = { name: roomName, members: new Map() };
      rooms.set(roomName, room);
      if (!states.has(roomName)) states.set(roomName, new RoomState());
    }
    if (room.members.size >= MAX_MEMBERS_PER_ROOM) return null;
    room.members.set(socket, { socket, cid, alive: true });
    idleSince.delete(roomName);
    return room;
  }

  function handleMessage(socket: WebSocket, room: Room, raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      send(socket, { t: 'error', error: '消息不是合法 JSON' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
      send(socket, { t: 'error', error: '缺少消息类型 t' });
      return;
    }
    if (msg.t !== 'rpc_req' && Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
      send(socket, { t: 'error', error: '协同消息超过 4MB 单帧上限' });
      return;
    }

    // 用闭包里的 room 实例而不是 rooms.get(roomName)：
    // 房间可能因成员全走而被销毁、随后同名新房间重建，此时旧 socket 的消息不应打进新房。
    if (!room.members.has(socket)) {
      send(socket, { t: 'error', error: '尚未加入房间' });
      return;
    }
    const state = states.get(room.name);
    if (!state) {
      send(socket, { t: 'error', error: '房间状态不存在' });
      return;
    }

    switch (msg.t) {
      case 'state': {
        // 整份 blueprint 不能直接覆盖：那样任何成员一发 state 就能抹掉别人的数据，
        // 与 (rev, cid) LWW 语义冲突。改为逐条走 upsert 裁决，只有更新的记录胜出。
        const bp = (msg as { blueprint?: unknown }).blueprint;
        if (!bp || typeof bp !== 'object') {
          send(socket, { t: 'error', error: 'state 缺少 blueprint' });
          return;
        }
        const incoming = bp as Record<string, unknown>;
        let changed = false;
        for (const kind of COLLECTIONS) {
          const src = incoming[kind];
          if (!src || typeof src !== 'object') continue;
          let count = 0;
          for (const rec of Object.values(src as Record<string, unknown>)) {
            if (count >= MAX_RECORDS_PER_COLLECTION) break;
            if (!isVersionedRecord(rec)) continue;
            if (state.upsert(kind, rec)) changed = true;
            count += 1;
          }
        }
        if (changed) {
          schedulePersistRoom(room.name);
          broadcast(room, { t: 'state', blueprint: state.snapshot() }, socket);
        }
        return;
      }
      case 'upsert_node':
      case 'upsert_ann':
      case 'upsert_edge': {
        const field =
          msg.t === 'upsert_node' ? 'node' : msg.t === 'upsert_ann' ? 'annotation' : 'edge';
        const kind: Collection =
          msg.t === 'upsert_node' ? 'nodes' : msg.t === 'upsert_ann' ? 'annotations' : 'edges';
        const rec = (msg as unknown as Record<string, unknown>)[field];
        if (!isVersionedRecord(rec)) {
          send(socket, { t: 'error', error: `${field} 字段不合法` });
          return;
        }
        if (!state.upsert(kind, rec)) {
          // 被 LWW 判定为过期，静默丢弃——这是正常并发结果，不是错误。
          return;
        }
        schedulePersistRoom(room.name);
        broadcast(room, msg, socket);
        return;
      }
      case 'delete_node':
      case 'delete_ann':
      case 'delete_edge': {
        const kind: Collection =
          msg.t === 'delete_node' ? 'nodes' : msg.t === 'delete_ann' ? 'annotations' : 'edges';
        const id = (msg as { id?: unknown }).id;
        if (typeof id !== 'string' || !id) {
          send(socket, { t: 'error', error: 'delete 缺少 id' });
          return;
        }
        // delete 帧不带 rev/cid，直接删除（见 RoomState.remove 的说明）。
        state.remove(kind, id);
        schedulePersistRoom(room.name);
        broadcast(room, msg, socket);
        return;
      }
      case 'hello':
        // 客户端在 onopen 时会补发 hello（连接 URL 里已带 room/cid），忽略即可。
        return;
      case 'rpc_req': {
        // 前端的 /api/* 请求在这里下船：整包交给注入的后端处理器，结果按 id 送回去。
        // 注意：这是异步的，但不需要 await——多个请求可以并发在途，各自带 id 配对。
        const frame = msg as RpcRequestFrame;
        if (typeof frame.id !== 'string' || !frame.id) {
          send(socket, { t: 'error', error: 'rpc_req 缺少 id' });
          return;
        }
        if (!rpcHandler) {
          send(socket, {
            t: 'rpc_res',
            id: frame.id,
            status: 501,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: false, error: '服务端未启用 RPC 转发' }),
            bodyEncoding: 'text',
          } satisfies RpcResponseFrame);
          return;
        }
        void rpcHandler(frame)
          .then((res) => {
            if (res.bodyEncoding === 'binary' && res.rawBody) {
              if (socket.readyState === 1) {
                const bin = encodeBinaryRpcFrame(
                  {
                    t: 'rpc_res',
                    id: res.id,
                    status: res.status,
                    headers: res.headers,
                    bodyEncoding: 'binary',
                  },
                  res.rawBody
                );
                socket.send(bin);
              }
              return;
            }
            send(socket, res);
          })
          .catch((err: unknown) => {
            // 处理器自己炸了也要回一帧，否则客户端会一直等到超时。
            send(socket, {
              t: 'rpc_res',
              id: frame.id,
              status: 500,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                ok: false,
                error: `RPC 处理失败：${err instanceof Error ? err.message : String(err)}`,
              }),
              bodyEncoding: 'text',
            } satisfies RpcResponseFrame);
          });
        return;
      }
      case 'rtc_offer':
      case 'rtc_answer':
      case 'rtc_ice': {
        const senderCid = room.members.get(socket)?.cid || '';
        const toCid = typeof msg.to === 'string' ? msg.to.trim() : '';
        if (!senderCid || !toCid || toCid === senderCid) return;
        for (const member of room.members.values()) {
          if (member.cid === toCid) {
            send(member.socket, { ...msg, from: senderCid });
            break;
          }
        }
        return;
      }
      default:
        send(socket, { t: 'error', error: `未知消息类型：${(msg as { t: string }).t}` });
    }
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const parsedRoom = extractRoomPathFromWsPathname(url.pathname, wsPath, url.searchParams.get('room'));
    if (!parsedRoom.matched) {
      // 不归房间服务处理。只有在确实存在其他 upgrade 监听器时才让位；否则明确回 404 并关掉。
      if (httpServer.listenerCount('upgrade') > 1) return;
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (verifyToken) {
      const headerToken = Array.isArray(req.headers['x-proxy-token'])
        ? req.headers['x-proxy-token'][0]
        : req.headers['x-proxy-token'];
      const cookieToken = parseCookieValue(req.headers.cookie, 'atlas_session');
      const subprotocolToken = extractWsSubprotocolToken(req.headers['sec-websocket-protocol']);
      const providedToken = String(headerToken || cookieToken || subprotocolToken || '').trim();
      if (!verifyToken(providedToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const roomName = (parsedRoom.roomPath || '').trim();
    const cid = (url.searchParams.get('cid') || '').trim();
    if (!roomName || roomName.length > 100) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!cid || cid.length > 100) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIp = fwd || req.socket.remoteAddress || 'unknown';
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = join(roomName, ws, cid);
      if (!room) {
        try {
          ws.send(JSON.stringify({ t: 'error', error: '房间已满或达到房间数量上限' }));
        } catch {
          /* ignore */
        }
        ws.close();
        return;
      }

      const state = states.get(roomName);
      // 新成员立刻拿到全量快照，补齐入房前错过的一切。
      if (state && state.size > 0) {
        send(ws, { t: 'state', blueprint: state.snapshot() });
      } else if (roomName !== '__rpc__' && !hydratedRooms.has(roomName)) {
        hydratedRooms.add(roomName);
        void (async () => {
          const initialBp = getRoomStore ? await getRoomStore(roomName).readBlueprint().catch(() => null) : null;
          if (!initialBp || typeof initialBp !== 'object' || !state) return;
          const bpObj = initialBp as Record<string, unknown>;
          let restored = false;
          for (const kind of COLLECTIONS) {
            const col = bpObj[kind];
            if (!col || typeof col !== 'object') continue;
            for (const rec of Object.values(col as Record<string, unknown>)) {
              if (isVersionedRecord(rec) && state.upsert(kind, rec)) restored = true;
            }
          }
          if (restored && state.size > 0) {
            const snapMsg = { t: 'state', blueprint: state.snapshot() };
            for (const m of room.members.values()) {
              send(m.socket, snapMsg);
            }
          }
        })();
      }
      if (room.name !== '__rpc__') {
        const existingPeers = [...room.members.values()]
          .map((m) => m.cid)
          .filter((c) => c !== cid);
        if (existingPeers.length > 0) {
          send(ws, { t: 'peers', peers: existingPeers });
        }
      }
      broadcast(room, { t: 'peer_joined', cid }, ws);

      ws.on('message', (data, isBinary) => {
        const member = room.members.get(ws);
        if (member) member.alive = true;
        if (isBinary) {
          if (room.name !== '__rpc__') {
            send(ws, { t: 'error', error: '普通协同房间不接受二进制帧' });
            return;
          }
          const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const decoded = decodeBinaryRpcFrame(rawBuf);
          if (!decoded || decoded.meta.t !== 'rpc_req') {
            send(ws, { t: 'error', error: '二进制 RPC 帧格式无效' });
            return;
          }
          const binFrame: RpcRequestFrame = {
            t: 'rpc_req',
            id: String(decoded.meta.id || ''),
            method: String(decoded.meta.method || 'GET'),
            path: String(decoded.meta.path || '/'),
            headers: (decoded.meta.headers as Record<string, string>) || undefined,
            rawBody: decoded.payload,
            bodyEncoding: 'binary',
          };
          if (!binFrame.id) {
            send(ws, { t: 'error', error: 'rpc_req 缺少 id' });
            return;
          }
          if (!rpcHandler) {
            send(ws, {
              t: 'rpc_res',
              id: binFrame.id,
              status: 501,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ ok: false, error: '服务端未启用 RPC 转发' }),
              bodyEncoding: 'text',
            } satisfies RpcResponseFrame);
            return;
          }
          void rpcHandler(binFrame)
            .then((res) => {
              if (res.bodyEncoding === 'binary' && res.rawBody && ws.readyState === 1) {
                ws.send(
                  encodeBinaryRpcFrame(
                    { t: 'rpc_res', id: res.id, status: res.status, headers: res.headers, bodyEncoding: 'binary' },
                    res.rawBody
                  )
                );
                return;
              }
              send(ws, res);
            })
            .catch((err: unknown) => {
              send(ws, {
                t: 'rpc_res',
                id: binFrame.id,
                status: 500,
                headers: { 'content-type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ ok: false, error: `RPC 处理失败：${err instanceof Error ? err.message : String(err)}` }),
                bodyEncoding: 'text',
              } satisfies RpcResponseFrame);
            });
          return;
        }
        handleMessage(ws, room, String(data));
      });
      ws.on('pong', () => {
        const member = room.members.get(ws);
        if (member) member.alive = true;
      });
      ws.on('close', () => leave(room, ws));
      ws.on('error', () => leave(room, ws));
    });
  });

  // 心跳：把上一轮没响应 pong 的连接判死摘掉，防止半开连接永久占位
  // （原 Go 实现缺这一层，浏览器进程被杀后会留下 phantom member）。
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const member of [...room.members.values()]) {
        if (!member.alive) {
          leave(room, member.socket);
          try {
            member.socket.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        member.alive = false;
        try {
          member.socket.ping();
        } catch {
          /* ignore */
        }
      }
      // 成员被心跳摘光后，开始计空闲；超过 TTL 才真正回收状态。
      if (room.members.size === 0 && !idleSince.has(room.name)) {
        idleSince.set(room.name, now);
      }
      const idleAt = idleSince.get(room.name);
      if (idleAt !== undefined && room.members.size === 0 && now - idleAt > ROOM_IDLE_TTL_MS) {
        rooms.delete(room.name);
        states.delete(room.name);
        hydratedRooms.delete(room.name);
        idleSince.delete(room.name);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    stats: () => ({
      rooms: rooms.size,
      members: [...rooms.values()].reduce((sum, r) => sum + r.members.size, 0),
    }),
    syncPublishedBlueprint(roomName: string, blueprint: unknown) {
      if (!roomName || roomName === '__rpc__' || !blueprint || typeof blueprint !== 'object') return;
      let st = states.get(roomName);
      if (!st) {
        st = new RoomState();
        states.set(roomName, st);
      }
      st.replaceSnapshot(blueprint as Record<string, unknown>);
      hydratedRooms.add(roomName);
      const room = rooms.get(roomName);
      if (room) {
        broadcast(room, { t: 'state', blueprint: st.snapshot(), replace: true });
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        const flushTasks: Promise<void>[] = [];
        for (const [rName, t] of persistTimers.entries()) {
          clearTimeout(t);
          const st = states.get(rName);
          if (getRoomStore && st) {
            flushTasks.push(getRoomStore(rName).writeBlueprint(st.snapshot()).then(() => {}).catch(() => {}));
          }
        }
        persistTimers.clear();
        void Promise.all(flushTasks);
        for (const room of rooms.values()) {
          for (const member of room.members.values()) {
            try {
              member.socket.close();
            } catch {
              /* ignore */
            }
          }
        }
        rooms.clear();
        states.clear();
        idleSince.clear();
        wss.close(() => resolve());
      }),
  };
}
