/**
 * @file mockApi.ts
 * @description 浏览器端的 /api/* 入口与 fetch 拦截器。
 *
 * 这里**不含任何业务逻辑**。业务逻辑全在 `src/core/apiCore.ts`，服务端与浏览器
 * 跑的是同一份。本文件只做三件事，都是浏览器特有的：
 *
 *   1. 装上 fetch 拦截器，把 /api/* 请求导向 apiCore（或转发给服务端）
 *   2. 提供 IndexedDB 版 BlueprintStore（服务端用的是内存版）
 *   3. 提供基于浏览器 fetch 的 HttpFetcher（服务端那版额外带 SSRF 防护）
 *
 * 两种模式：
 *   - 配置了 VITE_BACKEND_WS_URL：请求经 WebSocket 送到服务端，由服务端跑 apiCore。
 *     此时安全边界（白名单、限流、SSRF 防护、鉴权）生效。
 *   - 没配置：在浏览器里直接跑 apiCore，数据存 IndexedDB。
 *     能离线演示，但没有可信边界——CORS 之外的一切限制都只是"提示"，用户改前端就能绕。
 *
 * 两种模式下接口契约与返回结构完全一致，所以 App.tsx 一行都不用改。
 */

import { idbGet, idbSet } from './idbStorage';
import { RpcClient, frameToResponse } from './rpcClient';
import { normalizeWsUrl } from './runtimeConfig';
import {
  createWindowRateLimiter,
  handleApiRequest,
  type ApiDeps,
  type ApiRequest,
  type ApiResult,
  type BlueprintStore,
  type HttpFetcher,
} from './apiCore';

export interface MockProxyStatus {
  enabled: boolean;
  mock: true;
  hasUpstreamSecret: boolean;
  allowedHosts: string[];
}

// ─────────────────────────── 浏览器侧依赖实现 ───────────────────────────

const BLUEPRINT_KEY = 'atlas-hybrid-mock-server-blueprint-v1';
const REVISION_KEY = 'atlas-hybrid-mock-server-revision-v1';

/** IndexedDB 版存储，接口与服务端的 createMemoryStore() 完全一致。 */
const browserStore: BlueprintStore = {
  async readRevision() {
    const raw = await idbGet<number>(REVISION_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
  },
  async writeRevision(rev) {
    await idbSet(REVISION_KEY, rev);
  },
  async readBlueprint() {
    return idbGet<unknown>(BLUEPRINT_KEY);
  },
  async writeBlueprint(bp) {
    return idbSet(BLUEPRINT_KEY, bp);
  },
};

/**
 * 浏览器版出站请求。
 *
 * 刻意**不做**内网 IP 拦截：浏览器拿不到 DNS 解析结果，也读不到对端 IP，
 * 写个判断只会是自我安慰。真正的 SSRF 防护只能在服务端做——这也是为什么
 * 配了 VITE_BACKEND_WS_URL 时要把请求交给服务端。
 */
let rawWindowFetch: typeof window.fetch | null = null;

const browserFetcher: HttpFetcher = {
  async fetch(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const doFetch = rawWindowFetch ?? fetch;
    try {
      const res = await doFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body ? new Uint8Array(init.body) : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
      // 浏览器 redirect:'manual' 遇到 3xx 返回 opaqueredirect (status === 0)，映射为 302 由 apiCore 统一拦截
      if (res.type === 'opaqueredirect' || res.status === 0) {
        return { status: 302, headers: {}, body: new Uint8Array(0) };
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, headers, body: buf };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** 与服务端同名的白名单解析，默认值和 .env.example 保持一致。 */
function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? 'httpbin.org,api.github.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const ALLOWED_HOSTS = parseAllowedHosts(import.meta.env.VITE_PROXY_ALLOWED_HOSTS);
const MOCK_SAVE_KEY = (import.meta.env.VITE_MOCK_SAVE_KEY || 'atlas-demo-key').trim();
const PROXY_RATE_LIMIT_PER_MIN = Math.max(
  1,
  Number(import.meta.env.VITE_PROXY_RATE_LIMIT_PER_MIN || 30)
);

const browserDeps: ApiDeps = {
  store: browserStore,
  proxy: {
    allowedHosts: ALLOWED_HOSTS,
    hasUpstreamSecret: false,
    saveKey: MOCK_SAVE_KEY,
    rateLimitPerMin: PROXY_RATE_LIMIT_PER_MIN,
  },
  rateLimiter: createWindowRateLimiter(PROXY_RATE_LIMIT_PER_MIN),
  fetcher: browserFetcher,
  mode: 'browser',
};

// ─────────────────────────── 服务端转发 ───────────────────────────

const RPC_WS_URL = normalizeWsUrl(String(import.meta.env.VITE_BACKEND_WS_URL ?? ''));
let rpcClient: RpcClient | null = null;

function getRpcClient(): RpcClient | null {
  if (!RPC_WS_URL) return null;
  if (!rpcClient) rpcClient = new RpcClient(RPC_WS_URL);
  return rpcClient;
}

/**
 * 把一个已经构造好的 Request 整包转发到服务端。
 *
 * 请求体按原始字节读出（不做 utf8 二次编码），响应体按原始字节还原成 Response，
 * 这样 PDF 这类二进制上传/下载经 WS 往返后仍然字节级一致。
 */
async function forwardViaRpc(req: Request, url: URL): Promise<Response> {
  const client = getRpcClient();
  if (!client) throw new Error('未配置 VITE_BACKEND_WS_URL');

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    // Host / Content-Length 由服务端自己决定，转发过去反而可能冲突。
    if (k === 'host' || k === 'content-length') return;
    headers[k] = v;
  });

  let raw: Uint8Array | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    raw = new Uint8Array(await req.clone().arrayBuffer());
  }

  const frame = await client.request({
    method: req.method,
    path: url.pathname + url.search,
    headers,
    body: raw && raw.length > 0 ? raw : undefined,
  });
  return frameToResponse(frame);
}

// ─────────────────────────── 拦截器 ───────────────────────────

/** 把 ApiResult 还原成标准 Response，让调用方继续用 res.json() / res.blob()。 */
function resultToResponse(result: ApiResult): Response {
  const nullBody = result.status === 204 || result.status === 304;
  return new Response(nullBody ? null : new Uint8Array(result.body), {
    status: result.status,
    headers: result.headers,
  });
}

/** 从 Request 取出 apiCore 需要的传输无关结构。 */
async function toApiRequest(req: Request, url: URL): Promise<ApiRequest> {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let body = new Uint8Array(0);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = new Uint8Array(await req.clone().arrayBuffer());
  }
  return {
    method: req.method,
    path: url.pathname + url.search,
    headers,
    body,
    clientId: 'browser',
  };
}

/**
 * 装上拦截器：只接管 /api/ 前缀，其余请求原样放行。
 *
 * 有配置后端时先经 WS 转发；转发失败（服务端没起、断网、握手超时）就退回到本地
 * 跑 apiCore，并在控制台留一条警告。这样"服务端挂了页面还能用"，但数据只落在
 * 本机，绝不会出现"看着在协同、其实各存各的"这种静默错配。
 */
export function installMockApi(): void {
  const originalFetch = window.fetch.bind(window);
  rawWindowFetch = originalFetch;
  const hasRemote = RPC_WS_URL !== null;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL;
    let req: Request | null = null;

    // 在 about:blank / srcdoc / file:// 等非 HTTP 宿主页中，window.location.href 不能作为相对路径 base
    const baseHref = /^https?:\/\//i.test(window.location.href)
      ? window.location.href
      : 'http://atlas.local/';
    if (input instanceof Request) {
      req = input;
      url = new URL(input.url, baseHref);
    } else {
      url = new URL(typeof input === 'string' ? input : input.toString(), baseHref);
    }

    const baseOrigin = new URL(baseHref).origin;
    if (url.origin !== baseOrigin || !url.pathname.startsWith('/api/')) {
      return originalFetch(input as RequestInfo, init);
    }

    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    let reqBody: BodyInit | undefined = init?.body ?? undefined;
    if (method === 'GET' || method === 'HEAD') {
      reqBody = undefined;
    } else if (reqBody === undefined && req) {
      const buf = await req.clone().arrayBuffer();
      if (buf.byteLength > 0) reqBody = buf;
    }
    const merged: RequestInit = {
      method,
      headers: init?.headers ?? req?.headers,
      ...(reqBody !== undefined ? { body: reqBody } : {}),
    };
    const syntheticReq = new Request(url.toString(), merged);

    // 1) 有后端就先交给它：那边有完整的安全边界。
    if (hasRemote) {
      try {
        return await forwardViaRpc(syntheticReq, url);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `%c[Atlas] 服务端转发失败，已退回本地处理：${method} ${url.pathname}`,
          'color:#b45309;font-weight:bold',
          err
        );
      }
    }

    // 2) 本地跑同一份 apiCore。
    const result = await handleApiRequest(browserDeps, await toApiRequest(syntheticReq, url));
    if (result) return resultToResponse(result);
    return originalFetch(input as RequestInfo, init);
  };

  // eslint-disable-next-line no-console
  if (hasRemote) {
    console.info(
      `%c[Atlas] 已连接后端：/api/* 经 WebSocket 转发到 ${RPC_WS_URL}`,
      'color:#0f766e;font-weight:bold'
    );
  } else {
    console.info(
      '%c[Atlas] 纯静态演示模式：/api/* 在浏览器内执行（与后端同一份 apiCore，数据存 IndexedDB）',
      'color:#0f766e;font-weight:bold'
    );
  }
}
