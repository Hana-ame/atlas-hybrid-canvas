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
  return refreshAuthSession({ cid, scheduleNext: true });
}

/** 合并业务需要的头，并在存在有效令牌时补上 X-Proxy-Token。 */
export function proxyHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = getActiveProxyToken();
  if (token) headers['X-Proxy-Token'] = token;
  return headers;
}

/** 为无法附带自定义请求头的 <img> 资源 URL（如 /api/pdf/:id/page/:page）在存在令牌时追加 token 查询参数。 */
export function appendProxyTokenQuery(url: string): string {
  const token = getActiveProxyToken();
  if (!token || !url) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
