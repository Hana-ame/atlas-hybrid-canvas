/**
 * @file apiClient.ts
 * @description 前端调用 /api/* 时统一补上 X-Proxy-Token 的工具，并管理 /api/auth/session 短时效签名令牌的自动换取与续期。
 *
 * 支持两种令牌来源（运行时签名会话令牌优先于构建期静态令牌）：
 * 1. 运行时从 POST /api/auth/session 换取的短时效 HMAC-SHA256 签名令牌（initAuthSession / setRuntimeProxyToken）；
 * 2. 构建期注入的 VITE_PROXY_CLIENT_TOKEN（兼容旧版静态部署）。
 */
const STATIC_CLIENT_TOKEN = String(
  (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, unknown> }).env?.VITE_PROXY_CLIENT_TOKEN) || ''
).trim();

let runtimeSessionToken = '';
let runtimeExpiresAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inflightRefresh: Promise<string> | null = null;
let initialAuthPromise: Promise<string> | null = null;

/** 注入运行时从 /api/auth/session 获取的短时效签名会话令牌。 */
export function setRuntimeProxyToken(token: string, expiresInSec?: number): void {
  runtimeSessionToken = String(token || '').trim();
  runtimeExpiresAt =
    runtimeSessionToken && typeof expiresInSec === 'number' && expiresInSec > 0
      ? Date.now() + expiresInSec * 1000
      : 0;
}

export function getActiveProxyToken(): string {
  if (runtimeSessionToken && (!runtimeExpiresAt || Date.now() < runtimeExpiresAt)) {
    return runtimeSessionToken;
  }
  return STATIC_CLIENT_TOKEN;
}

export function stopAuthSessionRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

export function getAuthSessionState(): { hasRuntimeToken: boolean; expiresAt: number } {
  return {
    hasRuntimeToken: Boolean(runtimeSessionToken && (!runtimeExpiresAt || Date.now() < runtimeExpiresAt)),
    expiresAt: runtimeExpiresAt,
  };
}

/**
 * 向 POST /api/auth/session 换取短时效 HMAC-SHA256 会话令牌，并在到期前自动静默续期。
 * 并发调用会自动合并为单次请求；在纯本地 mock 或开放模式下优雅降级且不抛错。
 */
export async function refreshAuthSession(options?: {
  fetchImpl?: typeof fetch;
  cid?: string;
  scheduleNext?: boolean;
}): Promise<string> {
  if (inflightRefresh) return inflightRefresh;
  const fetchFn = options?.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetchFn) return getActiveProxyToken();

  const scheduleNext = options?.scheduleNext !== false;

  inflightRefresh = (async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (STATIC_CLIENT_TOKEN) headers['X-Proxy-Token'] = STATIC_CLIENT_TOKEN;
      const resp = await fetchFn('/api/auth/session', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ cid: options?.cid || 'atlas-web' }),
      });
      if (!resp.ok) return getActiveProxyToken();
      const data = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        token?: string;
        expiresInSec?: number;
        mode?: string;
      } | null;
      if (data?.ok && data.mode === 'signed' && typeof data.token === 'string' && data.token.trim()) {
        const ttl = Number(data.expiresInSec) > 0 ? Number(data.expiresInSec) : 3600;
        setRuntimeProxyToken(data.token, ttl);
        if (scheduleNext) {
          stopAuthSessionRefresh();
          // 在 TTL 的 80% 处提前静默续期（最短 30 秒）
          const delayMs = Math.max(30_000, Math.round(ttl * 0.8 * 1000));
          refreshTimer = setTimeout(() => {
            void refreshAuthSession({ cid: options?.cid, scheduleNext: true });
          }, delayMs);
        }
        return runtimeSessionToken;
      }
      return getActiveProxyToken();
    } catch {
      return getActiveProxyToken();
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

/** 应用启动时调用一次，自动换取并维持短时效签名会话令牌。 */
export function initAuthSession(cid?: string): Promise<string> {
  initialAuthPromise = refreshAuthSession({ cid, scheduleNext: true });
  return initialAuthPromise;
}

/** 等待启动期会话鉴权完成（若未启用或超时则立即放行，避免首屏请求与 Set-Cookie 竞态）。 */
export async function waitForAuthSessionReady(timeoutMs = 2000): Promise<void> {
  if (!initialAuthPromise) return;
  await Promise.race([
    initialAuthPromise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 构造 WebSocket 鉴权子协议列表（`Sec-WebSocket-Protocol`）：
 * 既不在 URL 中泄露令牌，也能在跨源 WS 建连时携带有效鉴权凭证。
 */
export function buildWsAuthProtocols(): string[] {
  const token = getActiveProxyToken();
  if (!token) return [];
  return ['atlas-v1', `atlas-auth.${encodeBase64Url(token)}`];
}

/** 合并业务需要的头，并在存在有效令牌时补上 X-Proxy-Token。 */
export function proxyHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = getActiveProxyToken();
  if (token) headers['X-Proxy-Token'] = token;
  return headers;
}

/**
 * 返回安全的资源 URL：同源 <img> 与 /ws 请求依赖 /api/auth/session 下发的 HttpOnly Cookie 鉴权，
 * 不再将长期有效的签名 bearer token 拼入 URL 查询参数，避免泄露到浏览器历史、Referer 与代理访问日志。
 */
export function appendProxyTokenQuery(url: string): string {
  return url;
}
