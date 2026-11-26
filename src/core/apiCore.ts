/**
 * @file apiCore.ts
 * @description 后端 /api/* 业务逻辑的唯一实现。
 *
 * 为什么要有这个文件：同一套接口以前存在两份实现——`server/server.ts` 的 Express
 * 路由，和 `src/core/mockApi.ts` 里浏览器内的等价逻辑。两份各自演进，迟早会漂移：
 * 一边加了校验另一边没加，或者状态字段名对不上。用户看到的就是"本地能存、
 * 上线存不上"这类玄学问题。
 *
 * 这里把它收敛成一份：**纯函数，不碰 HTTP、不碰 Express、不碰浏览器 fetch**。
 * 输入是一个普通的请求描述（方法、路径、头、体），输出是一个普通的结果描述
 * （状态码、头、体）。谁来调用都行：
 *
 *   - 服务端：Express 路由把 req 转成 ApiRequest 传进来，把 ApiResult 写回 res
 *   - 浏览器：fetch 拦截器直接调用，无需经过网络
 *
 * 于是"没有后端时跑的就是 mock、有后端时就跑服务端"这个切换，变成"同一份代码
 * 在哪个环境里执行"，而不是"两套代码行为是否碰巧一致"。
 *
 * 有状态的部分（蓝图、revision、限流桶）通过 Storage 接口注入，因为服务端要存在
 * 进程内存里、浏览器要存 IndexedDB。
 */

// ─────────────────────────────── 传输无关的类型 ───────────────────────────────

export interface ApiRequest {
  method: string;
  /** 形如 `/api/proxy?x=1`，含查询串。 */
  path: string;
  headers: Record<string, string>;
  /** 请求体的原始字节。没有体则为空 Uint8Array。 */
  body: Uint8Array;
  /** 调用方标识，服务端用来限流；浏览器模式下用不到但要给个值。 */
  clientId?: string;
}

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  /** 响应体原始字节。JSON 也要序列化成字节，保证两个环境产出一致。 */
  body: Uint8Array;
}

// ─────────────────────────────── 依赖注入接口 ───────────────────────────────

/** 蓝图与 revision 的持久化。服务端用内存，浏览器用 IndexedDB。 */
export interface BlueprintStore {
  readBlueprint(): Promise<unknown>;
  writeBlueprint(bp: unknown): Promise<boolean>;
  readRevision(): Promise<number>;
  writeRevision(rev: number): Promise<void>;
}

/** 代理服务运行参数。两个环境各自从自己的配置源读，但结构一致。 */
export interface ProxyConfig {
  allowedHosts: string[];
  upstreamBaseUrl?: string;
  hasUpstreamSecret: boolean;
  saveKey: string;
  rateLimitPerMin: number;
}

/** 速率限制器。由调用方决定用内存还是别的实现。 */
export interface RateLimiter {
  check(clientId: string): { ok: boolean; retryAfterSec?: number };
}

/**
 * 出站 HTTP 能力。之所以不直接调 global fetch：
 * 服务端需要额外的 SSRF 防护（内网 IP 拦截、DNS 解析后二次校验），
 * 而浏览器做不到这些（拿不到对端 IP）。把这一步注入，两边各用各的真实能力，
 * 但**调用协议完全一致**。
 */
export interface HttpFetcher {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array }
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}

export interface ApiDeps {
  store: BlueprintStore;
  /** 可选：按路径分房间的蓝图存储解析器（缺省退回 store）。 */
  getRoomStore?: (roomPath: string) => BlueprintStore;
  proxy: ProxyConfig;
  rateLimiter: RateLimiter;
  fetcher: HttpFetcher;
  /** 当前运行环境。用来在响应里如实标注，避免"以为是真后端其实是本地"。 */
  mode: 'server' | 'browser';
}

// ─────────────────────────────── 小工具 ───────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function fromBytes(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function jsonResult(body: unknown, status = 200, extraHeaders?: Record<string, string>): ApiResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders ?? {}) },
    body: toBytes(JSON.stringify(body)),
  };
}

function parseJsonBody<T>(req: ApiRequest): T | null {
  if (req.body.length === 0) return null;
  try {
    return JSON.parse(fromBytes(req.body)) as T;
  } catch {
    return null;
  }
}

/** 头名大小写不敏感地取值。 */
function header(req: ApiRequest, name: string): string {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
let publishQueue: Promise<unknown> = Promise.resolve();
const MAX_RESPONSE_CHARS = 256 * 1024;
const PROXY_TIMEOUT_MS = 10_000;

// ─────────────────────────────── 各接口实现 ───────────────────────────────

async function handleBlueprintGet(deps: ApiDeps): Promise<ApiResult> {
  return jsonResult({
    ok: true,
    mock: deps.mode === 'browser',
    serverRevision: await deps.store.readRevision(),
    blueprint: await deps.store.readBlueprint(),
  });
}

async function handleBlueprintPublish(deps: ApiDeps, req: ApiRequest): Promise<ApiResult> {
  const expected = deps.proxy.saveKey;
  if (!expected) {
    return jsonResult(
      {
        ok: false,
        error: '未配置保存密钥，已禁止保存；普通用户仅可通过控件内置 API 访问后端',
      },
      403
    );
  }
  const provided = header(req, 'x-blueprint-save-key').trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return jsonResult(
      {
        ok: false,
        error:
          deps.mode === 'browser'
            ? '保存密钥错误（演示密钥：atlas-demo-key）；无密钥仅可使用控件内置 API 访问后端'
            : '保存密钥（Save Key）错误或缺失；无密钥仅可使用控件内预设 API，本地修改已保留在浏览器',
      },
      401
    );
  }

  const body = parseJsonBody<{ blueprint?: unknown }>(req);
  if (!body || typeof body.blueprint !== 'object' || body.blueprint === null) {
    return jsonResult({ ok: false, error: '无效的蓝图数据' }, 400);
  }
  const runAtomic = async (): Promise<ApiResult> => {
    const written = await deps.store.writeBlueprint(body.blueprint);
    if (!written) {
      return jsonResult({ ok: false, error: '存储已满，无法写入底座' }, 507);
    }
    const nextRev = (await deps.store.readRevision()) + 1;
    await deps.store.writeRevision(nextRev);
    return jsonResult({ ok: true, mock: deps.mode === 'browser', serverRevision: nextRev });
  };
  const nextPromise = publishQueue.then(runAtomic, runAtomic);
  publishQueue = nextPromise.catch(() => {});
  return nextPromise;
}

async function handleProxyStatus(deps: ApiDeps): Promise<ApiResult> {
  return jsonResult({
    enabled: true,
    mock: deps.mode === 'browser',
    hasUpstreamSecret: deps.proxy.hasUpstreamSecret,
    allowedHosts: deps.proxy.allowedHosts,
  });
}

/**
 * 代理调用的完整校验链。顺序是刻意安排的：便宜且确定性的检查先做，
 * 昂贵的网络操作最后——这样畸形请求不会消耗任何出站配额。
 */
async function handleProxy(deps: ApiDeps, req: ApiRequest): Promise<ApiResult> {
  // 1) 限流：放在最前面，连解析都省。恶意方刷接口时首先被挡在这里。
  const rl = deps.rateLimiter.check(req.clientId || 'unknown');
  if (!rl.ok) {
    return jsonResult(
      {
        ok: false,
        error: `代理请求过于频繁（上限 ${deps.proxy.rateLimitPerMin} 次/分钟），请 ${rl.retryAfterSec ?? 10} 秒后重试`,
      },
      429,
      { 'retry-after': String(rl.retryAfterSec ?? 10) }
    );
  }

  // 2) 方法白名单
  const body = parseJsonBody<{
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  }>(req);
  if (!body || typeof body !== 'object') {
    return jsonResult({ ok: false, error: '请求体格式无效' }, 400);
  }
  const method =
    typeof body.method === 'string' ? body.method.toUpperCase().trim() : 'POST';
  if (!ALLOWED_METHODS.has(method)) {
    return jsonResult({ ok: false, error: `不支持的 HTTP 方法：${method}` }, 400);
  }

  // 3) 目标 URL 形状（兼容 PROXY_UPSTREAM_BASE_URL 相对路径）
  const rawUrlStr = String(body.url ?? '').trim();
  const upstreamBase = (deps.proxy.upstreamBaseUrl ?? '').trim().replace(/\/+$/, '');
  let upstreamHost = '';
  if (upstreamBase) {
    try {
      upstreamHost = new URL(upstreamBase).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      upstreamHost = '';
    }
  }
  let resolvedUrlStr = rawUrlStr;
  if (rawUrlStr.startsWith('/') && !rawUrlStr.startsWith('//')) {
    if (!upstreamBase) {
      return jsonResult({ ok: false, error: '目标 URL 格式无效（未配置上游基础地址，相对路径不可用）' }, 400);
    }
    resolvedUrlStr = `${upstreamBase}${rawUrlStr}`;
  }
  let target: URL;
  try {
    target = new URL(resolvedUrlStr);
  } catch {
    return jsonResult({ ok: false, error: '目标 URL 格式无效' }, 400);
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return jsonResult({ ok: false, error: '只允许 http/https 协议' }, 400);
  }

  // 4) 域名白名单（自动并入 upstreamHost，支持精确域名与子域名匹配，与 proxySecurity.ts 保持一致）
  const hostLower = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const effectiveAllowlist = upstreamHost
    ? Array.from(new Set([...deps.proxy.allowedHosts, upstreamHost]))
    : deps.proxy.allowedHosts;
  const hostAllowed = effectiveAllowlist.some(
    (allowed) => allowed === '*' || hostLower === allowed || hostLower.endsWith(`.${allowed}`)
  );
  if (!hostAllowed) {
    return jsonResult(
      {
        ok: false,
        error: `目标域名不在白名单内：${target.hostname}（可选：${effectiveAllowlist.join(', ')}）`,
      },
      403
    );
  }

  // 5) 头与体
  const outHeaders: Record<string, string> = {};
  if (typeof body.headers === 'object' && body.headers) {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof v === 'string') outHeaders[k] = v;
    }
  }
  const outBody =
    method !== 'GET' && method !== 'HEAD' && typeof body.body === 'string'
      ? toBytes(body.body)
      : undefined;

  // 6) 出站请求。超时由 fetcher 自己实现，两边语义一致（10s）。
  let upstream: { status: number; headers: Record<string, string>; body: Uint8Array };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('__timeout__')), PROXY_TIMEOUT_MS);
  });
  try {
    upstream = await Promise.race([
      deps.fetcher.fetch(target.toString(), { method, headers: outHeaders, body: outBody }),
      timeout,
    ]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === '__timeout__';
    return jsonResult(
      {
        ok: false,
        error: isTimeout
          ? `代理请求超时（${PROXY_TIMEOUT_MS / 1000}s）`
          : deps.mode === 'browser'
            ? '代理请求失败：静态站受浏览器 CORS 限制，目标域名需允许跨域访问'
            : `代理请求失败：${err instanceof Error ? err.message : String(err)}`,
      },
      isTimeout ? 504 : 502
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  // 7) 拦截重定向：3xx 可能把请求引到白名单之外，一律不跟。
  if (upstream.status >= 300 && upstream.status < 400) {
    return jsonResult({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' }, 502);
  }

  // 8) 响应体限长 + 内容类型判定
  let text = fromBytes(upstream.body);
  if (text.length > MAX_RESPONSE_CHARS) {
    text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n…(响应已截断至 256KB)`;
  }
  const contentType = (upstream.headers['content-type'] ?? '').toLowerCase();
  let responseBody: unknown = text;
  if (contentType.includes('application/json')) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }

  return jsonResult({
    ok: upstream.status >= 200 && upstream.status < 300,
    status: upstream.status,
    responseBody,
    mock: deps.mode === 'browser',
  });
}

/** 定长比较，避免通过响应时间猜测密钥。浏览器与 Node 都能用。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────── 路由表 ───────────────────────────────

/**
 * 唯一的入口。两个环境都调它，不存在第二种实现。
 *
 * 返回 null 表示"这个路径不归我管"，调用方自行决定怎么处理
 * （Express 交给下一个中间件，浏览器拦截器原样放行）。
 */
export async function handleApiRequest(
  deps: ApiDeps,
  req: ApiRequest
): Promise<ApiResult | null> {
  const pathname = new URL(req.path, 'http://x').pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  const requireMethod = (want: string): ApiResult | null =>
    method === want ? null : jsonResult({ ok: false, error: 'Method Not Allowed' }, 405);

  // 按路径分房间蓝图接口：/api/rooms/<roomPath>/blueprint 与 /api/rooms/<roomPath>/blueprint/publish
  const roomBpMatch = pathname.match(/^\/api\/rooms\/(.+)\/blueprint(\/publish)?$/);
  if (roomBpMatch) {
    const rawRoom = roomBpMatch[1];
    const isPublish = Boolean(roomBpMatch[2]);
    const roomStore = deps.getRoomStore ? deps.getRoomStore(rawRoom) : deps.store;
    return handleApiRequest(
      { ...deps, store: roomStore },
      { ...req, path: isPublish ? '/api/blueprint/publish' : '/api/blueprint' }
    );
  }

  const roomHistMatch = pathname.match(/^\/api\/rooms\/(.+)\/(history|rollback)$/);
  if (roomHistMatch || pathname === '/api/history' || pathname === '/api/rollback') {
    const kind = roomHistMatch ? roomHistMatch[2] : pathname.endsWith('/history') ? 'history' : 'rollback';
    if (kind === 'history') {
      if (method !== 'GET') return jsonResult({ ok: false, error: 'Method Not Allowed' }, 405);
      return jsonResult({ ok: true, entries: [] }, 200);
    }
    if (method !== 'POST') return jsonResult({ ok: false, error: 'Method Not Allowed' }, 405);
    return jsonResult({ ok: false, error: '纯静态模式不支持服务端版本回档' }, 403);
  }

  switch (pathname) {
    case '/api/auth/session': {
      if (method !== 'POST') {
        return {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
          body: new TextEncoder().encode(JSON.stringify({ ok: false, error: 'Method Not Allowed' })),
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true, token: '', expiresInSec: 0, mode: 'open' })),
      };
    }
    case '/api/blueprint': {
      const bad = requireMethod('GET');
      return bad ?? handleBlueprintGet(deps);
    }
    case '/api/blueprint/publish': {
      const bad = requireMethod('POST');
      return bad ?? handleBlueprintPublish(deps, req);
    }
    case '/api/proxy/status': {
      const bad = requireMethod('GET');
      return bad ?? handleProxyStatus(deps);
    }
    case '/api/proxy': {
      const bad = requireMethod('POST');
      return bad ?? handleProxy(deps, req);
    }
    default:
      return null;
  }
}

// ─────────────────────────────── 共用的适配器实现 ───────────────────────────────

/** 进程内存版存储。服务端用它；浏览器端在 mockApi 里用 IndexedDB 实现同一接口。 */
export function createMemoryStore(): BlueprintStore {
  let blueprint: unknown = null;
  let revision = 1;
  return {
    async readBlueprint() {
      return blueprint;
    },
    async writeBlueprint(bp) {
      blueprint = bp;
      return true;
    },
    async readRevision() {
      return revision;
    },
    async writeRevision(rev) {
      revision = rev;
    },
  };
}

/**
 * 浏览器端的简易限流：按 clientId 记时间戳，滑动 60 秒窗口。
 *
 * 只给浏览器模式用。服务端**不要**用它——那边已经有一份带定期清理的
 * checkProxyRateLimit，直接适配成 RateLimiter 接口即可，避免两份限流实现。
 */
export function createWindowRateLimiter(perMinute: number): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(clientId: string) {
      if (perMinute <= 0) return { ok: true };
      const now = Date.now();
      const windowStart = now - 60_000;
      const arr = (hits.get(clientId) ?? []).filter((t) => t > windowStart);
      if (arr.length >= perMinute) {
        const retryAfterSec = Math.max(1, Math.ceil((arr[0] + 60_000 - now) / 1000));
        hits.set(clientId, arr);
        return { ok: false, retryAfterSec };
      }
      arr.push(now);
      hits.set(clientId, arr);
      return { ok: true };
    },
  };
}
