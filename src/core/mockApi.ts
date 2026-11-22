/**
 * GitHub Pages 用的纯前端 mock 后端。
 *
 * Pages 只能托管静态文件，`server/server.ts` 里的 Express 路由不存在，
 * 所以这里用 fetch 拦截器在浏览器内实现同样的三个接口契约：
 *   GET  /api/blueprint
 *   POST /api/blueprint/publish
 *   GET  /api/proxy/status
 *   POST /api/proxy
 *
 * 状态存在 localStorage，行为对 App.tsx 完全透明 —— 不需要改任何业务代码。
 * 只在生产构建里启用；`npm run dev` 仍然打真后端。
 */

export interface MockProxyStatus {
  enabled: boolean;
  mock: true;
  hasUpstreamSecret: boolean;
  allowedHosts: string[];
}

const BLUEPRINT_KEY = 'atlas-hybrid-mock-server-blueprint-v1';
const REVISION_KEY = 'atlas-hybrid-mock-server-revision-v1';

function readRevision(): number {
  const raw = localStorage.getItem(REVISION_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

function writeRevision(rev: number): void {
  try {
    localStorage.setItem(REVISION_KEY, String(rev));
  } catch {
    /* 配额满了就只在内存里走一遭，不影响演示 */
  }
}

function readBlueprint(): unknown {
  try {
    const raw = localStorage.getItem(BLUEPRINT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeBlueprint(bp: unknown): boolean {
  try {
    localStorage.setItem(BLUEPRINT_KEY, JSON.stringify(bp));
    return true;
  } catch {
    return false;
  }
}

/** 与服务端同名的白名单解析，默认值和 .env.example 保持一致。 */
function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? 'httpbin.org,api.github.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const ALLOWED_HOSTS = parseAllowedHosts(import.meta.env.VITE_PROXY_ALLOWED_HOSTS);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MAX_RESPONSE_CHARS = 256 * 1024;
const PROXY_TIMEOUT_MS = 10_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

interface ProxyRequestBody {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
}

/**
 * 静态站上的代理没有服务端可信边界可言：白名单和密钥注入在这里只是
 * "演示语义"，真正能做的防护只有交给浏览器 CORS。所以这里如实说明：
 * 只允许白名单域、拦截重定向、限制响应体积，但**不做**内网 IP 拦截
 * （浏览器也拿不到对端 IP，写了也是假安全）。
 */
async function handleProxy(req: Request): Promise<Response> {
  let body: ProxyRequestBody | null = null;
  try {
    body = (await req.json()) as ProxyRequestBody;
  } catch {
    return json({ ok: false, error: '请求体格式无效' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求体格式无效' }, 400);
  }

  const method = typeof body.method === 'string' ? body.method.toUpperCase().trim() : 'POST';
  if (!ALLOWED_METHODS.has(method)) {
    return json({ ok: false, error: `不支持的 HTTP 方法：${method}` }, 400);
  }

  let target: URL;
  try {
    target = new URL(String(body.url ?? ''));
  } catch {
    return json({ ok: false, error: '目标 URL 格式无效' }, 400);
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json({ ok: false, error: '只允许 http/https 协议' }, 400);
  }
  if (!ALLOWED_HOSTS.includes(target.hostname.toLowerCase())) {
    return json(
      { ok: false, error: `目标域名不在白名单内：${target.hostname}（可选：${ALLOWED_HOSTS.join(', ')}）` },
      403,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const init: RequestInit = { method, redirect: 'manual', signal: controller.signal };
    if (typeof body.headers === 'object' && body.headers) {
      // 只透传字符串值，避免把宿主对象塞进 fetch 头。
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
        if (typeof v === 'string') hdrs[k] = v;
      }
      init.headers = hdrs;
    }
    if (method !== 'GET' && method !== 'HEAD' && typeof body.body === 'string') {
      init.body = body.body;
    }

    const upstreamRes = await fetch(target.toString(), init);
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      return json({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' }, 502);
    }

    const contentType = upstreamRes.headers.get('content-type') ?? '';
    const fullText = await upstreamRes.text();
    const rawText =
      fullText.length > MAX_RESPONSE_CHARS
        ? `${fullText.slice(0, MAX_RESPONSE_CHARS)}\n…(响应已截断至 256KB)`
        : fullText;

    let responseBody: unknown = rawText;
    if (contentType.toLowerCase().includes('application/json')) {
      try {
        responseBody = JSON.parse(rawText);
      } catch {
        responseBody = rawText;
      }
    }
    return json({ ok: upstreamRes.ok, status: upstreamRes.status, responseBody, mock: true });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return json(
      {
        ok: false,
        error: isAbort
          ? '代理请求超时（10s）'
          : '代理请求失败：静态站受浏览器 CORS 限制，目标域名需允许跨域访问',
      },
      isAbort ? 504 : 502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function route(url: URL, req: Request): Promise<Response | null> {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/api/blueprint') {
    if (req.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    return json({ ok: true, mock: true, serverRevision: readRevision(), blueprint: readBlueprint() });
  }

  if (pathname === '/api/blueprint/publish') {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    let payload: { blueprint?: unknown } | null = null;
    try {
      payload = (await req.json()) as { blueprint?: unknown };
    } catch {
      return json({ ok: false, error: '无效的蓝图数据' }, 400);
    }
    if (!payload || typeof payload.blueprint !== 'object' || payload.blueprint === null) {
      return json({ ok: false, error: '无效的蓝图数据' }, 400);
    }
    if (!writeBlueprint(payload.blueprint)) {
      return json({ ok: false, error: '浏览器存储已满，无法写入底座' }, 507);
    }
    const nextRev = readRevision() + 1;
    writeRevision(nextRev);
    return json({ ok: true, mock: true, serverRevision: nextRev });
  }

  if (pathname === '/api/proxy/status') {
    if (req.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    const status: MockProxyStatus = {
      enabled: true,
      mock: true,
      hasUpstreamSecret: false,
      allowedHosts: ALLOWED_HOSTS,
    };
    return json(status);
  }

  if (pathname === '/api/proxy') {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    return handleProxy(req);
  }

  return null;
}

/** 装上拦截器：只接管 /api/ 前缀，其余请求原样放行。 */
export function installMockApi(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL | null = null;
    let req: Request | null = null;

    if (input instanceof Request) {
      req = input;
      url = new URL(input.url, window.location.href);
    } else {
      url = new URL(typeof input === 'string' ? input : input.toString(), window.location.href);
    }

    if (!url.pathname.startsWith('/api/')) {
      return originalFetch(input as RequestInfo, init);
    }

    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    // 用 init 优先，其次复用原 Request 的 body/headers，保证两处调用都能命中。
    const merged: RequestInit = {
      method,
      headers: init?.headers ?? req?.headers,
      body: init?.body ?? (req ? await req.clone().text() : undefined),
    };
    const syntheticReq = new Request(url.toString(), merged);

    const handled = await route(url, syntheticReq);
    return handled ?? originalFetch(input as RequestInfo, init);
  };

  // 方便在控制台确认当前跑的是 mock。
  // eslint-disable-next-line no-console
  console.info(
    '%c[Atlas] GitHub Pages 静态模式：/api/* 由浏览器内 mock 提供（base blueprint 存 localStorage）',
    'color:#0f766e;font-weight:bold',
  );
}
