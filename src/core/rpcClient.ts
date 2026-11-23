import { appendProxyTokenQuery } from './apiClient';
/**
 * @file rpcClient.ts
 * @description 把浏览器的 /api/* 请求经 WebSocket 转发到服务端处理。
 *
 * 这是"复用组件"的关键一环：服务端仍用同一套 Express 路由（不重写任何业务逻辑），
 * 前端仍用同一套 fetch 调用点（App.tsx / PdfViewerBlock 一行不改），中间只把传输层
 * 从 HTTP 换成一条可长连的 WS。
 *
 * 为什么要 WS 而不是直接 fetch：
 * - 纯静态托管（GitHub Pages）下前端与服务端不同源，直连会被 CORS 或证书拦住；
 *   而 WS 一旦握手成功就是双向长连，不再受同源策略逐个请求的限制。
 * - 一条连接承载所有请求，省掉每次的 TLS 握手开销，保活也由这里统一处理。
 *
 * 协议：
 *   请求 { t:'rpc_req', id, method, path, headers, body, bodyEncoding }
 *   响应 { t:'rpc_res', id, status, headers, body, bodyEncoding }
 * `id` 用于并发配对；每次 request() 返回一个独立的 Promise。
 */

import type { RpcRequestFrame, RpcResponseFrame } from '../../server/roomServer';
import { decodeBinaryRpcFrame, encodeBinaryRpcFrame } from './rpcBinaryFrame';

type Pending = {
  resolve: (res: RpcResponseFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** 断线后的重连退避上限，避免服务端宕机时把浏览器拖垮。 */
const RECONNECT_MAX_DELAY_MS = 15_000;

export class RpcClient {
  private ws: WebSocket | null = null;
  private connectingWs: WebSocket | null = null;
  private abortConnecting: ((msg: string) => void) | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private closedByUser = false;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly wsUrl: string;
  constructor(private readonly url: string) {
    let target = url;
    try {
      const u = new URL(url);
      if (!u.searchParams.get('room')) u.searchParams.set('room', '__rpc__');
      if (!u.searchParams.get('cid')) u.searchParams.set('cid', `rpc-${Math.random().toString(36).slice(2, 10)}`);
      target = u.toString();
    } catch {
      // keep raw url
    }
    this.wsUrl = target;
  }

  /** 复用已建立的连接；没有则建一条。并发调用共享同一次握手。 */
  private ensureOpen(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }
    if (this.connecting) return this.connecting;

    let settled = false;
    const p = new Promise<WebSocket>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.connecting = null;
        this.abortConnecting = null;
        reject(new Error(msg));
      };
      this.abortConnecting = fail;

      let ws: WebSocket;
      try {
        ws = new WebSocket(appendProxyTokenQuery(this.wsUrl));
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        fail(`无法创建 RPC WebSocket：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.connectingWs = ws;

      timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fail(`连接 RPC 服务端超时（${CONNECT_TIMEOUT_MS}ms）：${this.url}`);
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (this.connectingWs === ws) this.connectingWs = null;
        if (this.closedByUser) {
          try { ws.close(); } catch { /* ignore */ }
          fail('RPC 客户端已关闭');
          return;
        }
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.ws = ws;
        this.connecting = null;
        this.abortConnecting = null;
        this.reconnectDelay = 500;
        resolve(ws);
      };

      ws.onmessage = (ev) => this.onFrame(ev.data);

      ws.onerror = () => {
        // 只负责在建连阶段报错；已连上后由 onclose 统一处理重连。
        fail(`无法连接 RPC 服务端：${this.url}`);
      };

      ws.onclose = () => {
        const wasActive = this.ws === ws;
        const wasConnecting = this.connectingWs === ws;
        if (wasActive) this.ws = null;
        if (wasConnecting) this.connectingWs = null;
        if (!wasActive && !wasConnecting) return;
        if (wasActive) {
          // 仅当关闭的是当前活跃连接时才中止在途请求，避免旧连接延迟 onclose 误杀新连接
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('RPC 连接已断开'));
            this.pending.delete(id);
          }
        }
        fail(`RPC 连接被关闭：${this.url}`);
        if (!this.closedByUser) this.scheduleReconnect();
      };
    });
    if (!settled) this.connecting = p;
    return p;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 失败就再退避一次；成功了下次 request() 会自然复用。
      void this.ensureOpen().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private onFrame(raw: unknown): void {
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const binBytes =
        raw instanceof ArrayBuffer
          ? raw
          : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const decoded = decodeBinaryRpcFrame(binBytes);
      if (!decoded || decoded.meta.t !== 'rpc_res' || typeof decoded.meta.id !== 'string') return;
      const p = this.pending.get(decoded.meta.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(decoded.meta.id);
      p.resolve({
        t: 'rpc_res',
        id: decoded.meta.id,
        status: Number(decoded.meta.status || 200),
        headers: (decoded.meta.headers as Record<string, string>) || {},
        body: '',
        rawBody: decoded.payload,
        bodyEncoding: 'binary',
      });
      return;
    }
    let msg: RpcResponseFrame | { t?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const res = msg as RpcResponseFrame;
    if (res.t !== 'rpc_res' || typeof res.id !== 'string') return;
    const p = this.pending.get(res.id);
    if (!p) return; // 超时后迟到的响应，直接丢
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    p.resolve(res);
  }

  /** 发一次请求，拿回一帧响应。响应体由调用方自己解码。 */
  async request(init: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<RpcResponseFrame> {
    const ws = await this.ensureOpen();
    const id = `r${++this.seq}-${Date.now().toString(36)}`;

    const isBinaryReq = init.body instanceof Uint8Array && init.body.length > 0;
    const bodyStr = typeof init.body === 'string' ? init.body : undefined;

    const frame: RpcRequestFrame = {
      t: 'rpc_req',
      id,
      method: init.method,
      path: init.path,
      headers: init.headers,
      body: bodyStr,
      bodyEncoding: isBinaryReq ? 'binary' : 'text',
    };

    return new Promise<RpcResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 请求超时（${REQUEST_TIMEOUT_MS}ms）：${init.method} ${init.path}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (isBinaryReq) {
          const bin = encodeBinaryRpcFrame(
            {
              t: 'rpc_req',
              id,
              method: init.method,
              path: init.path,
              headers: init.headers,
              bodyEncoding: 'binary',
            },
            init.body as Uint8Array
          );
          ws.send(bin);
        } else {
          ws.send(JSON.stringify(frame));
        }
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const cws = this.connectingWs;
    this.connectingWs = null;
    this.abortConnecting?.('RPC 客户端已关闭');
    try { cws?.close(); } catch { /* ignore */ }
    const aws = this.ws;
    this.ws = null;
    try { aws?.close(); } catch { /* ignore */ }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('RPC 客户端已关闭'));
      this.pending.delete(id);
    }
  }
}

/** 把 RpcResponseFrame 还原成标准 Response，让调用方继续用 res.json() / res.blob()。 */
export function frameToResponse(frame: RpcResponseFrame): Response {
  let body: BodyInit | null;
  if (frame.bodyEncoding === 'binary' && frame.rawBody) {
    body = new Uint8Array(frame.rawBody);
  } else if (frame.bodyEncoding === 'base64' && frame.body) {
    const binary = atob(frame.body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    body = bytes;
  } else {
    body = frame.body ?? '';
  }
  // 204/304 不允许带 body，构造 Response 会抛。
  const nullBody = frame.status === 204 || frame.status === 304;
  return new Response(nullBody ? null : body, {
    status: frame.status,
    headers: frame.headers,
  });
}
