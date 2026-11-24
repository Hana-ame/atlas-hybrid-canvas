/**
 * @file apiClient.ts
 * @description 前端会话令牌管理（零硬编码静态密钥）：
 * - 纯前端静态 mock 模式完全匿名；
 * - 连后端模式下由 Node 侧 POST /api/auth/session 签发短时效防自动化 HMAC 会话令牌与 HttpOnly Cookie；
 * - 管理密钥（BLUEPRINT_SAVE_KEY）与上游密钥（PROXY_API_KEY）仅留在 Node 侧，前端包内绝不包含任何静态密钥。
 */

let runtimeSessionToken = '';
let runtimeExpiresAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inflightRefresh: Promise<string> | null = null;
let initialAuthPromise: Promise<string> | null = null;

/** 注入运行时从 /api/auth/session 获取的短时效防自动化会话令牌。 */
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
  return '';
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
 * 向 POST /api/auth/session 申请短时效防自动化会话令牌与 HttpOnly Cookie，并在到期前自动续期。
 * 并发调用自动去重；在纯静态匿名 mock 模式下返回 mode='open' 并静默降级。
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
      const resp = await fetchFn('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

/** 应用启动时调用一次，自动申请防自动化会话令牌（纯静态模式下走本地 apiCore 直接返回 open，无网络噪音）。 */
export function initAuthSession(cid?: string): Promise<string> {
  initialAuthPromise = refreshAuthSession({ cid, scheduleNext: true });
  return initialAuthPromise;
}

/** 等待启动期会话申请完成（超时自动放行，避免阻塞首屏）。 */
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

/** 构造 WebSocket 鉴权子协议列表（不向 URL 拼接任何令牌）。 */
export function buildWsAuthProtocols(): string[] {
  const token = getActiveProxyToken();
  if (!token) return [];
  return ['atlas-v1', `atlas-auth.${encodeBase64Url(token)}`];
}

/** 合并业务请求头，存在运行时会话令牌时补上 X-Proxy-Token。 */
export function proxyHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = getActiveProxyToken();
  if (token) headers['X-Proxy-Token'] = token;
  return headers;
}

/** 保持 URL 干净（同源 <img> 与 /ws 依赖 HttpOnly Cookie，绝不把令牌拼进查询参数）。 */
export function appendProxyTokenQuery(url: string): string {
  return url;
}
