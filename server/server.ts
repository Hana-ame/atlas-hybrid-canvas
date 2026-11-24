import 'dotenv/config';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPrivateOrReservedIP,
  parseAllowedHosts,
  PROXY_DEFAULT_TIMEOUT_MS,
  sanitizeProxyHeaders,
  sanitizeBinaryProxyContentType,
  validateProxyTargetUrl,
} from './proxySecurity';
import {
  getUnpackedPdfMeta,
  getUnpackedPdfPage,
  unpackPdfBufferToPages,
} from './pdfUnpack';
import { attachRoomServer, type RoomServerHandle, type RpcHandler } from './roomServer';
import { createRoomBlueprintStoreRegistry, listPersistedRooms } from './fileStore';
import { normalizeRoomPath } from '../src/core/roomPath';
import { issueSignedSessionToken, parseCookieValue, verifySignedSessionToken } from './authSession';
import {
  handleApiRequest,
  type ApiDeps,
  type ApiRequest,
  type ApiResult,
  type HttpFetcher,
} from '../src/core/apiCore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 端口默认 8787：与前端 App.tsx 里 ws://localhost:8787/ws 的默认房间地址保持一致，
// 让 `npm run dev` 起的就是"API + 协同房间"合一的单一进程，不需要再单独拉 room-go/。
const PORT = Number(process.env.PORT || 8787);
const IS_PROD = process.env.NODE_ENV === 'production';

// PDF 上传单文件上限。走二进制直传，不再有 base64 的 4/3 膨胀，
// 因此这里就是文件的真身体积；前后端共用同一数值，避免两边阈值漂移。
const PDF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const PDF_UPLOAD_MAX_LABEL = '50MB';

// 权威底座与协同房间持久化目录（默认 .atlas-data/，可通过 ATLAS_DATA_DIR 覆盖）。
const DATA_DIR = path.resolve(process.env.ATLAS_DATA_DIR || path.join(__dirname, '../.atlas-data'));
const roomBlueprintRegistry = createRoomBlueprintStoreRegistry(DATA_DIR);
const sharedStore = roomBlueprintRegistry.getStore();

// 房间服务实例。必须在 httpServer 建好之后才能 attach，而 stats 路由又要注册在
// SPA fallback 之前，所以用模块级变量在注册时先捕获引用、attach 后再赋值。
let roomServer: RoomServerHandle | null = null;

/** 这些响应头没必要回传给浏览器，传了反而可能干扰。 */
const INTERNAL_RPC_SECRET = crypto.randomBytes(24).toString('hex');

const RPC_DROP_RES_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'date',
  'etag',
]);

/**
 * 构造 RPC 处理器：把 WS 上的 rpc_req 变成一次对**本机自己**的真实 HTTP 调用。
 *
 * 为什么走自回环而不是构造合成 req/res 对象：
 * Express 的一整条中间件链（json/raw parser、限流、鉴权、SSRF 防护、静态资源、
 * req.ip 解析）都依赖真实的 IncomingMessage/ServerResponse。伪造对象要么漏掉某层
 * 防护、要么在某些中间件里炸掉。回环一次虽然多一跳本机 TCP，但拿到的是**和浏览器
 * 直连完全一致**的行为——这正是"复用组件"要的效果：不重写任何业务逻辑。
 */
function makeRpcHandler(port: number): RpcHandler {
  return (frame) =>
    new Promise((resolve) => {
      const rawPath = String(frame.path || '/');
      let normalizedPath = '/';
      try {
        const parsed = new URL(rawPath, 'http://127.0.0.1');
        normalizedPath = `${parsed.pathname}${parsed.search}`;
      } catch {
        normalizedPath = '/';
      }
      // 规范化 .. 段后再校验 /api/ 前缀，防止路径遍历绕过
      if (!normalizedPath.startsWith('/api/')) {
        resolve({
          t: 'rpc_res',
          id: frame.id,
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ ok: false, error: 'RPC 只允许访问 /api/* 路径' }),
          bodyEncoding: 'text',
        });
        return;
      }

      const isBase64 = frame.bodyEncoding === 'base64';
      const bodyBuf = frame.rawBody
        ? Buffer.from(frame.rawBody)
        : frame.body
          ? Buffer.from(frame.body, isBase64 ? 'base64' : 'utf8')
          : Buffer.alloc(0);

      const headers: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(frame.headers || {})) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'content-length' || lk === 'transfer-encoding') continue;
        if (typeof v === 'string') headers[lk] = v;
      }
      // 标记来源，方便服务端日志区分"浏览器直连"与"经 WS 转发"。
      headers['x-atlas-rpc'] = '1';
      headers['x-atlas-rpc-secret'] = INTERNAL_RPC_SECRET;
      if (frame.clientIp) headers['x-atlas-rpc-ip'] = frame.clientIp;
      if (bodyBuf.length > 0) headers['content-length'] = bodyBuf.length;

      let settled = false;
      const done = (r: Awaited<ReturnType<RpcHandler>>) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const MAX_RPC_RES_BYTES = 64 * 1024 * 1024;

      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: String(frame.method || 'GET').toUpperCase(),
          path: normalizedPath,
          headers,
          timeout: 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on('data', (c: Buffer) => {
            totalBytes += c.byteLength;
            if (totalBytes > MAX_RPC_RES_BYTES) {
              req.destroy(new Error('RPC 响应体超过上限'));
              return;
            }
            chunks.push(c);
          });
          res.on('error', (err) => {
            done({
              t: 'rpc_res',
              id: frame.id,
              status: 502,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ ok: false, error: `RPC 响应流异常：${err.message}` }),
              bodyEncoding: 'text',
            });
          });
          res.on('aborted', () => {
            done({
              t: 'rpc_res',
              id: frame.id,
              status: 502,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ ok: false, error: 'RPC 响应流异常中断' }),
              bodyEncoding: 'text',
            });
          });
          res.on('end', () => {
            const buf = Buffer.concat(chunks, totalBytes);
            const resHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (RPC_DROP_RES_HEADERS.has(k.toLowerCase())) continue;
              if (typeof v === 'string') resHeaders[k] = v;
              else if (Array.isArray(v)) resHeaders[k] = v.join(', ');
            }
            recordRpcStatus(res.statusCode ?? 0);
            const ct = String(resHeaders['content-type'] || '').toLowerCase();
            const isText =
              ct.includes('json') ||
              ct.startsWith('text/') ||
              ct.includes('javascript') ||
              ct.includes('xml') ||
              buf.length === 0;
            if (isText) {
              done({
                t: 'rpc_res',
                id: frame.id,
                status: res.statusCode ?? 502,
                headers: resHeaders,
                body: buf.toString('utf8'),
                bodyEncoding: 'text',
              });
            } else {
              done({
                t: 'rpc_res',
                id: frame.id,
                status: res.statusCode ?? 502,
                headers: resHeaders,
                body: '',
                rawBody: new Uint8Array(buf),
                bodyEncoding: 'binary',
              });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('上游处理超时'));
      });
      req.on('error', (err) => {
        done({
          t: 'rpc_res',
          id: frame.id,
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ ok: false, error: `RPC 回环失败：${err.message}` }),
          bodyEncoding: 'text',
        });
      });

      if (bodyBuf.length > 0) req.write(bodyBuf);
      req.end();
    });
}

// 转发计数：给 /api/room/stats 用，便于确认"线上确实在走服务端"而不是本地 mock。
let rpcForwarded = 0;
function recordRpcStatus(_status: number): void {
  rpcForwarded += 1;
}

async function startServer() {
  const app = express();
  const corsAllowedOrigins = new Set(
    String(process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  app.use((req, res, next) => {
    const origin = String(req.header('origin') || '').trim();
    if (origin && corsAllowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Proxy-Token, X-Blueprint-Save-Key, X-Room-Path'
      );
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  const getRealClientIp = (req: express.Request): string => {
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (isLoopback && req.header('x-atlas-rpc-secret') === INTERNAL_RPC_SECRET) {
      const rpcIp = String(req.header('x-atlas-rpc-ip') || '').trim();
      if (rpcIp) return rpcIp;
    }
    return req.ip || remote || 'unknown';
  };
  app.disable('x-powered-by');
  // PDF 上传改成直接传二进制（Content-Type: application/pdf），不再走 base64 JSON。
  // 原来的 base64 会把 15MB 膨胀成 20.00MB，正好撞上 express.json 的 limit，
  // 导致文件在进入路由前就被 413 掉。这里用 express.raw 精确接住 PDF 字节，
  // 体积按原始大小算，上限就是文件真实大小，不再有编码膨胀这层耦合。
  // json 的 limit 也回落到常规的 1mb——它现在只承载 blueprint 这类小 JSON。
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/pdf/upload', express.raw({ type: 'application/pdf', limit: PDF_UPLOAD_MAX_BYTES }));
  app.use('/api/pdf/unpack-upload', express.raw({ type: 'application/pdf', limit: PDF_UPLOAD_MAX_BYTES }));

  // 协同房间在线统计。必须注册在 Vite / SPA fallback 之前，否则会被 `app.get('*')`
  // 的兜底先吃掉、返回首页 HTML。房间服务实例要等 httpServer 建好才能 attach，
  // 所以这里通过闭包读模块级变量，等 listen 之后再赋值。


  const blueprintSaveKey = (process.env.BLUEPRINT_SAVE_KEY || '').trim();
  const upstreamBaseUrl = (process.env.PROXY_UPSTREAM_BASE_URL || '').trim();
  const allowedHosts = parseAllowedHosts(process.env.PROXY_ALLOWED_HOSTS);
  const proxyApiKey = (process.env.PROXY_API_KEY || '').trim();
  // 防自动化会话签名密钥（仅留 Node 侧读取，前端零静态密钥）
  const authSessionSecret = (process.env.AUTH_SESSION_SECRET || '').trim();
  const proxyRateLimitPerMin = Math.max(1, Number(process.env.PROXY_RATE_LIMIT_PER_MIN || 30));
  const proxyRateHits = new Map<string, number[]>();

  const verifyProxyClientToken = (provided: string): boolean => {
    if (!authSessionSecret) return true;
    if (!provided) return false;
    return verifySignedSessionToken(authSessionSecret, provided).valid;
  };

  // 服务健康检查探针（供 Docker/K8s/反向代理做存活与就绪检测）
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'up',
      uptimeSec: Math.round(process.uptime()),
      authMode: authSessionSecret ? 'session' : 'open',
    });
  });

  // 从请求头或 HttpOnly Cookie 提取会话/代理令牌（不再依赖 URL 查询参数透传长期 bearer token）
  const extractRequestProxyToken = (req: express.Request): string => {
    const fromHeader = String(req.header('x-proxy-token') || '').trim();
    if (fromHeader) return fromHeader;
    const fromCookie = parseCookieValue(req.header('cookie'), 'atlas_session').trim();
    if (fromCookie) return fromCookie;
    return '';
  };

  // 签发短时效 HMAC-SHA256 会话令牌，并下发 HttpOnly Cookie 供 <img> 与 /ws 使用
  app.post('/api/auth/session', (req, res) => {
    const rl = checkProxyRateLimit(getRealClientIp(req));
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `会话签发过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
      return;
    }
    if (!authSessionSecret) {
      res.json({ ok: true, token: '', expiresInSec: 0, mode: 'open' });
      return;
    }
    const origin = String(req.header('origin') || '').trim();
    const host = String(req.header('host') || '').trim();
    const isSameOrigin = Boolean(origin && host && (origin === `http://${host}` || origin === `https://${host}`));
    const isAllowedCorsOrigin = Boolean(origin && corsAllowedOrigins.has(origin));
    if (origin && !isSameOrigin && !isAllowedCorsOrigin) {
      res.status(403).json({ ok: false, error: '非法 Origin，拒绝签发会话令牌' });
      return;
    }
    const sub = String((req.body as { cid?: unknown } | undefined)?.cid || getRealClientIp(req) || 'atlas-client');
    const ttlSec = 3600;
    const token = issueSignedSessionToken(authSessionSecret, sub, ttlSec);
    const isHttps = req.secure || String(req.header('x-forwarded-proto') || '').toLowerCase() === 'https';
    const sameSite = isAllowedCorsOrigin && isHttps ? 'SameSite=None' : 'SameSite=Strict';
    const cookieParts = [
      `atlas_session=${encodeURIComponent(token)}`,
      'HttpOnly',
      sameSite,
      'Path=/',
      `Max-Age=${ttlSec}`,
    ];
    if (isHttps || sameSite === 'SameSite=None') cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.json({ ok: true, token, expiresInSec: ttlSec, mode: 'signed' });
  });

  let lastRateSweepAt = Date.now();
  const checkProxyRateLimit = (ip: string): { ok: boolean; retryAfterSec?: number } => {
    const now = Date.now();
    const windowMs = 60_000;
    // 定期清理过期 IP 桶（满 5 分钟或条目超 200），防止长跑内存缓慢增长
    if (now - lastRateSweepAt > 300_000 || proxyRateHits.size > 200) {
      lastRateSweepAt = now;
      for (const [key, timestamps] of proxyRateHits) {
        const fresh = timestamps.filter((ts) => now - ts < windowMs);
        if (fresh.length === 0) proxyRateHits.delete(key);
        else proxyRateHits.set(key, fresh);
      }
    }
    const list = (proxyRateHits.get(ip) ?? []).filter((ts) => now - ts < windowMs);
    if (list.length >= proxyRateLimitPerMin) {
      const oldest = list[0];
      proxyRateHits.set(ip, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
    }
    list.push(now);
    proxyRateHits.set(ip, list);
    return { ok: true };
  };
  const proxyApiKeyHeader = (process.env.PROXY_API_KEY_HEADER || 'Authorization').trim() || 'Authorization';
  const proxyApiKeyPrefix =
    process.env.PROXY_API_KEY_PREFIX !== undefined
      ? process.env.PROXY_API_KEY_PREFIX
      : proxyApiKeyHeader.toLowerCase() === 'authorization'
        ? 'Bearer '
        : '';

  // 1) 获取/发布后端权威底座（Base Blueprint + defaultVars）
  //    以及 2) 防 SSRF 服务端密钥代理 —— 这两个的业务逻辑**不在本文件里**，
  //    唯一实现在 src/core/apiCore.ts。这里只做传输适配：把 Express 的 req/res
  //    翻译成 ApiRequest / ApiResult。浏览器端跑的是同一份 apiCore。

  /**
   * 服务端出站请求：承载 apiCore 无法在浏览器里做到的那部分防护。
   * 浏览器拿不到对端 IP、也没有 DNS 解析权限，所以这些检查只能在这里做——
   * 这正是"同一份业务逻辑、各环境用各自真实能力"的落点。
   */
  /**
   * 固定已校验 IP 的出站 HTTP/HTTPS 请求（彻底消除 DNS rebinding 二次解析窗口）。
   * - 先 dns.lookup({ all: true }) 校验全部解析结果均非内网/保留地址；
   * - 通过自定义 lookup 将 TCP 连接严格钉死在已校验 IP，同时保留 TLS SNI (servername) 与 Host 头；
   * - 不跟随 3xx 重定向，流式累计字节并在超限时立即销毁连接防 OOM。
   */
  const pinnedOutboundRequest = async (
    targetUrl: URL,
    opts: {
      method: string;
      headers: Record<string, string>;
      body?: Uint8Array;
      maxBytes: number;
      timeoutMs?: number;
    }
  ): Promise<
    | { ok: true; status: number; headers: Record<string, string>; buffer: Buffer }
    | { ok: false; kind: 'dns_blocked' | 'dns_failed' | 'too_large' | 'network'; error: string }
  > => {
    const lookupHost = targetUrl.hostname.replace(/^\[|\]$/g, '');
    let records: Array<{ address: string; family: number }>;
    try {
      records = await dns.lookup(lookupHost, { all: true });
    } catch {
      return { ok: false, kind: 'dns_failed', error: '目标域名解析失败' };
    }
    if (records.length === 0 || records.some((r) => isPrivateOrReservedIP(r.address))) {
      return {
        ok: false,
        kind: 'dns_blocked',
        error: '安全限制：目标域名解析到受保护的内网或元数据地址，已拒绝代理',
      };
    }
    const pinned = records[0];
    const isHttps = targetUrl.protocol === 'https:';
    const port = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;
    const reqHeaders: Record<string, string | number> = {
      ...opts.headers,
      host: targetUrl.host,
    };
    const bodyBuf = opts.body && opts.body.byteLength > 0 ? Buffer.from(opts.body) : undefined;
    if (bodyBuf) reqHeaders['content-length'] = bodyBuf.byteLength;

    return new Promise((resolve) => {
      let settled = false;
      const done = (
        result:
          | { ok: true; status: number; headers: Record<string, string>; buffer: Buffer }
          | { ok: false; kind: 'dns_blocked' | 'dns_failed' | 'too_large' | 'network'; error: string }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const pinnedLookup = (
        _hostname: string,
        lookupOpts: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void
      ) => {
        const wantsAll =
          typeof lookupOpts === 'object' &&
          lookupOpts !== null &&
          Boolean((lookupOpts as { all?: boolean }).all);
        if (wantsAll) {
          cb(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          cb(null, pinned.address, pinned.family);
        }
      };

      const reqFn = isHttps ? https.request : http.request;
      const req = reqFn(
        {
          hostname: lookupHost,
          port,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: opts.method,
          headers: reqHeaders,
          lookup: pinnedLookup as unknown as typeof import('node:dns').lookup,
          ...(isHttps ? { servername: lookupHost } : {}),
        },
        (res) => {
          const contentLen = Number(res.headers['content-length'] || 0);
          if (Number.isFinite(contentLen) && contentLen > opts.maxBytes) {
            res.destroy();
            done({ ok: false, kind: 'too_large', error: '上游响应体超过安全上限' });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > opts.maxBytes) {
              res.destroy();
              done({ ok: false, kind: 'too_large', error: '上游响应体超过安全上限' });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const outHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === undefined) continue;
              outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
            }
            done({
              ok: true,
              status: res.statusCode ?? 502,
              headers: outHeaders,
              buffer: Buffer.concat(chunks),
            });
          });
          res.on('error', (err) => {
            done({ ok: false, kind: 'network', error: err.message || '上游读取失败' });
          });
        }
      );

      const timer = setTimeout(() => {
        req.destroy(new Error('上游请求超时'));
      }, opts.timeoutMs ?? PROXY_DEFAULT_TIMEOUT_MS);

      req.on('error', (err) => {
        done({ ok: false, kind: 'network', error: err.message || '上游请求失败' });
      });

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  };

  const serverFetcher: HttpFetcher = {
    async fetch(url, init) {
      // a) 目标 URL 形状与白名单（复用 proxySecurity，别在这里重写一份）
      const target = validateProxyTargetUrl(url, { upstreamBaseUrl, allowedHosts });
      if (!target.ok) throw new Error(target.error);

      // b) 头净化（去掉 Host / Cookie 这类不该透传的）
      const headerCheck = sanitizeProxyHeaders(init.headers);
      if (!headerCheck.ok) throw new Error(headerCheck.error);

      // c) 按配置注入上游密钥。调用方自己带了同名头就不覆盖。
      const outboundHeaders: Record<string, string> = { ...headerCheck.headers };
      if (proxyApiKey && target.injectSecret) {
        const hasClientOverride = Object.keys(outboundHeaders).some(
          (k) => k.toLowerCase() === proxyApiKeyHeader.toLowerCase()
        );
        if (!hasClientOverride) {
          outboundHeaders[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
        }
      }

      // d) 固定已校验 IP 发请求（防 DNS rebinding + 不跟随 3xx + 2MB 流式上限）
      const out = await pinnedOutboundRequest(target.url, {
        method: init.method,
        headers: outboundHeaders,
        body: init.body,
        maxBytes: 2 * 1024 * 1024,
      });
      if (!out.ok) {
        if (out.kind === 'too_large') {
          throw new Error('上游响应体超过 2MB 安全上限，已中止读取');
        }
        throw new Error(out.error);
      }
      return { status: out.status, headers: out.headers, body: new Uint8Array(out.buffer) };
    },
  };

  const apiDeps: ApiDeps = {
    store: sharedStore,
    proxy: {
      allowedHosts,
      upstreamBaseUrl,
      hasUpstreamSecret: Boolean(proxyApiKey),
      saveKey: blueprintSaveKey,
      rateLimitPerMin: proxyRateLimitPerMin,
    },
    // 复用已有的 checkProxyRateLimit（带定期清理），只做接口适配，不另起一份实现。
    rateLimiter: { check: (clientId: string) => checkProxyRateLimit(clientId) },
    fetcher: serverFetcher,
    mode: 'server',
  };

  /** 把 Express 的 req 转成传输无关的 ApiRequest。 */
  const toApiRequest = (req: express.Request): ApiRequest => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }
    let body = new Uint8Array(0);
    // express.json / express.raw 已经把体解析好了；这里统一还原成字节，
    // 让 apiCore 只面对一种输入形态。
    if (Buffer.isBuffer(req.body)) {
      body = new Uint8Array(req.body);
    } else if (req.body && typeof req.body === 'object') {
      body = new TextEncoder().encode(JSON.stringify(req.body));
    }
    return {
      method: req.method,
      path: req.originalUrl || req.url,
      headers,
      body,
      clientId: getRealClientIp(req),
    };
  };

  /** 把 ApiResult 写回 Express 的 res。 */
  const writeApiResult = (res: express.Response, result: ApiResult): void => {
    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(Buffer.from(result.body));
  };

  /**
   * 部署层鉴权：配置了 PROXY_CLIENT_TOKEN 就必须带对 X-Proxy-Token。
   * 这一步刻意不进 apiCore —— 浏览器端没有"部署层"这个概念，也没有可信的令牌
   * 存放位置（前端 bundle 里的常量谁都能读）。所以它只在这一侧成立。
   */
  app.use('/api/proxy', (req, res, next) => {
    const isBinaryRoute = req.path === '/binary';
    const provided = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(provided)) {
      res.status(401).json({
        ok: false,
        error: '代理调用未授权：缺少或错误的 X-Proxy-Token',
      });
      return;
    }
    next();
  });

  /**
   * 统一挂载：路径列表与 apiCore 的 switch 一一对应。
   * 加新接口只需在 apiCore 里加一个 case，这里加一行路径。
   */
  const resolveRoomApiDeps = (roomPath?: string | null) => {
    const normalized = normalizeRoomPath(roomPath);
    return {
      ...apiDeps,
      store: roomBlueprintRegistry.getStore(normalized),
    };
  };

  const requireClientAuth: express.RequestHandler = (req, res, next) => {
    const provided = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(provided)) {
      res.status(401).json({ ok: false, error: '未授权访问：缺少或无效的会话凭证' });
      return;
    }
    next();
  };

  app.get('/api/room/stats', requireClientAuth, (_req, res) => {
    if (!roomServer) {
      res.status(503).json({ ok: false, error: '房间服务尚未就绪' });
      return;
    }
    res.json({ ok: true, ...roomServer.stats(), rpcForwarded });
  });

  // 按 path 分房间的蓝图读取与发布接口（启用鉴权时统一受 requireClientAuth 保护）：
  app.get('/api/rooms', requireClientAuth, async (_req, res) => {
    const persisted = await listPersistedRooms(DATA_DIR);
    res.json({
      ok: true,
      active: roomServer ? roomServer.stats() : { rooms: 0, clients: 0 },
      persisted,
    });
  });

  app.get(/^\/api\/rooms\/(.+)\/blueprint$/, requireClientAuth, async (req, res) => {
    const roomPath = normalizeRoomPath(req.params[0]);
    const apiReq = toApiRequest(req);
    const result = await handleApiRequest(resolveRoomApiDeps(roomPath), {
      ...apiReq,
      path: '/api/blueprint',
    });
    if (!result) {
      res.status(404).json({ ok: false, error: '未实现的蓝图读取接口' });
      return;
    }
    writeApiResult(res, result);
  });

  app.post(/^\/api\/rooms\/(.+)\/blueprint\/publish$/, requireClientAuth, async (req, res) => {
    const roomPath = normalizeRoomPath(req.params[0]);
    const apiReq = toApiRequest(req);
    const result = await handleApiRequest(resolveRoomApiDeps(roomPath), {
      ...apiReq,
      path: '/api/blueprint/publish',
    });
    if (!result) {
      res.status(404).json({ ok: false, error: '未实现的蓝图发布接口' });
      return;
    }
    if (result.status === 200) {
      const bp = (req.body as { blueprint?: unknown } | undefined)?.blueprint;
      if (bp) {
        await roomBlueprintRegistry.getStore(roomPath).recordHistory('publish', {
          actor: getRealClientIp(req),
          summary: '管理员发布蓝图',
          blueprint: bp,
        });
        roomServer?.syncPublishedBlueprint(roomPath, bp);
      }
    }
    writeApiResult(res, result);
  });

  const verifySaveKey = (providedKey: string): boolean => {
    if (!blueprintSaveKey || !providedKey) return false;
    const a = Buffer.from(providedKey, 'utf8');
    const b = Buffer.from(blueprintSaveKey, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  app.get(/^\/api\/rooms\/(.+)\/history$/, requireClientAuth, async (req, res) => {
    const roomPath = normalizeRoomPath(req.params[0]);
    const entries = await roomBlueprintRegistry.getStore(roomPath).listHistory();
    res.json({ ok: true, room: roomPath, entries });
  });

  app.get('/api/history', requireClientAuth, async (req, res) => {
    const roomPath = normalizeRoomPath(String(req.query.room || req.header('x-room-path') || ''));
    const entries = await roomBlueprintRegistry.getStore(roomPath).listHistory();
    res.json({ ok: true, room: roomPath, entries });
  });

  const handleRollbackRequest = async (roomPath: string, req: express.Request, res: express.Response) => {
    const saveKey = String(req.header('x-blueprint-save-key') || '').trim();
    if (!blueprintSaveKey) {
      res.status(403).json({ ok: false, error: '服务端未配置 BLUEPRINT_SAVE_KEY，禁止回档' });
      return;
    }
    if (!verifySaveKey(saveKey)) {
      res.status(401).json({ ok: false, error: '管理员保存密钥错误，拒绝回档' });
      return;
    }
    const version = Number((req.body as { version?: unknown } | undefined)?.version);
    if (!Number.isFinite(version) || version < 1) {
      res.status(400).json({ ok: false, error: '缺少合法的目标版本号 version' });
      return;
    }
    const out = await roomBlueprintRegistry.getStore(roomPath).rollbackToVersion(Math.trunc(version), getRealClientIp(req));
    if (!out.ok) {
      res.status(404).json({ ok: false, error: out.error || '版本不存在' });
      return;
    }
    roomServer?.syncPublishedBlueprint(roomPath, out.blueprint);
    res.json({ ok: true, room: roomPath, revision: out.revision, blueprint: out.blueprint, entry: out.entry });
  };

  app.post('/api/rollback', requireClientAuth, async (req, res) => {
    const roomPath = normalizeRoomPath(String(req.query.room || req.header('x-room-path') || ''));
    await handleRollbackRequest(roomPath, req, res);
  });

  app.post(/^\/api\/rooms\/(.+)\/rollback$/, requireClientAuth, async (req, res) => {
    const roomPath = normalizeRoomPath(req.params[0]);
    await handleRollbackRequest(roomPath, req, res);
  });

  for (const routePath of [
    '/api/blueprint',
    '/api/blueprint/publish',
    '/api/proxy/status',
    '/api/proxy',
  ]) {
    app.all(routePath, requireClientAuth, async (req, res) => {
      const requestedRoom = String(req.query.room || req.header('x-room-path') || '').trim();
      const deps =
        (routePath === '/api/blueprint' || routePath === '/api/blueprint/publish') && requestedRoom
          ? resolveRoomApiDeps(requestedRoom)
          : apiDeps;
      const result = await handleApiRequest(deps, toApiRequest(req));
      if (!result) {
        res.status(404).json({ ok: false, error: `未实现的接口：${routePath}` });
        return;
      }
      if (routePath === '/api/blueprint/publish' && result.status === 200) {
        const targetRoom = normalizeRoomPath(requestedRoom);
        const bp = (req.body as { blueprint?: unknown } | undefined)?.blueprint;
        if (bp) {
          await roomBlueprintRegistry.getStore(targetRoom).recordHistory('publish', {
            actor: getRealClientIp(req),
            summary: '管理员发布蓝图',
            blueprint: bp,
          });
          roomServer?.syncPublishedBlueprint(targetRoom, bp);
        }
      }
      writeApiResult(res, result);
    });
  }

  // 2.5) 二进制 PDF 代理转发与上传托管（复用同套 SSRF、限流与可选令牌鉴权）
  const uploadedPdfStore = new Map<string, { filename: string; buf: Buffer; createdAt: number }>();
  const MAX_UPLOADED_PDFS = 20;

  app.get('/api/proxy/binary', async (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `代理请求过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '代理调用未授权' });
      return;
    }
    const rawUrl = String(req.query.url || '').trim();
    const target = validateProxyTargetUrl(rawUrl, { upstreamBaseUrl, allowedHosts });
    if (!target.ok) {
      res.status(target.status).json({ ok: false, error: target.error });
      return;
    }
    const headers: Record<string, string> = {};
    if (proxyApiKey && target.injectSecret) {
      headers[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
    }
    const out = await pinnedOutboundRequest(target.url, {
      method: 'GET',
      headers,
      maxBytes: PDF_UPLOAD_MAX_BYTES,
    });
    if (!out.ok) {
      if (out.kind === 'dns_blocked') {
        res.status(403).json({ ok: false, error: '安全限制：目标域名解析到受保护地址' });
        return;
      }
      if (out.kind === 'too_large') {
        res.status(413).json({ ok: false, error: `PDF 文件超过 ${PDF_UPLOAD_MAX_LABEL} 代理上限` });
        return;
      }
      res.status(502).json({ ok: false, error: out.error || 'PDF 代理拉取失败' });
      return;
    }
    if (out.status >= 300 && out.status < 400) {
      res.status(502).json({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' });
      return;
    }
    // 上游 Content-Type 不可全信：透传 text/html 或 image/svg+xml 配合 inline 会在同源执行脚本。
    res.setHeader('Content-Type', sanitizeBinaryProxyContentType(out.headers['content-type'] ?? null));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.status(out.status).send(out.buffer);
  });

  app.post('/api/pdf/upload', (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: '上传过于频繁，请稍后重试' });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '未授权上传' });
      return;
    }
    // 请求体由上方 express.raw({ type: 'application/pdf' }) 直接给出原始字节，
    // 不再做 base64 解码，上限对应的就是文件真实大小（见 PDF_UPLOAD_MAX_BYTES）
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.byteLength === 0) {
      res.status(400).json({ ok: false, error: '缺少 PDF 数据（请以 application/pdf 提交原始字节）' });
      return;
    }
    if (buf.byteLength > PDF_UPLOAD_MAX_BYTES) {
      res.status(413).json({ ok: false, error: `PDF 文件大小需在 1B–${PDF_UPLOAD_MAX_LABEL} 之间` });
      return;
    }
    if (buf.subarray(0, 4).toString('ascii') !== '%PDF') {
      res.status(400).json({ ok: false, error: '文件头校验失败，仅允许标准 PDF 文件' });
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    // 文件名通过 X-Pdf-Filename 头传递；非 ASCII 名由前端 encodeURIComponent 编码后解回
    let rawName = String(req.header('x-pdf-filename') || 'document.pdf');
    try {
      rawName = decodeURIComponent(rawName);
    } catch {
      // 未编码的原始头值，保持原样
    }
    const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'document.pdf';
    if (uploadedPdfStore.size >= MAX_UPLOADED_PDFS) {
      const oldestKey = uploadedPdfStore.keys().next().value;
      if (oldestKey) uploadedPdfStore.delete(oldestKey);
    }
    uploadedPdfStore.set(id, { filename, buf, createdAt: Date.now() });
    res.json({ ok: true, id, url: `/api/pdf/${id}` });
  });

  // 解包远程 PDF URL 为逐页 PNG 图片（严格复用 SSRF/3xx/50MB 流式上限校验，且不与超时 controller 共用）
  app.post('/api/pdf/unpack', async (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `请求过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '未授权解包请求' });
      return;
    }
    const rawUrl = String((req.body as { url?: unknown } | undefined)?.url || '').trim();
    const target = validateProxyTargetUrl(rawUrl, { upstreamBaseUrl, allowedHosts });
    if (!target.ok) {
      res.status(target.status).json({ ok: false, error: target.error });
      return;
    }
    const headers: Record<string, string> = {};
    if (proxyApiKey && target.injectSecret) {
      headers[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
    }
    const out = await pinnedOutboundRequest(target.url, {
      method: 'GET',
      headers,
      maxBytes: PDF_UPLOAD_MAX_BYTES,
    });
    if (!out.ok) {
      if (out.kind === 'dns_blocked') {
        res.status(403).json({ ok: false, error: '安全限制：目标域名解析到受保护地址' });
        return;
      }
      if (out.kind === 'too_large') {
        res.status(413).json({ ok: false, error: `PDF 文件超过 ${PDF_UPLOAD_MAX_LABEL} 上限` });
        return;
      }
      res.status(502).json({ ok: false, error: out.error || 'PDF 解包失败' });
      return;
    }
    if (out.status >= 300 && out.status < 400) {
      res.status(502).json({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' });
      return;
    }
    if (out.status < 200 || out.status >= 300) {
      res.status(502).json({ ok: false, error: `拉取 PDF 失败（HTTP ${out.status}）` });
      return;
    }
    try {
      const unpacked = await unpackPdfBufferToPages(out.buffer);
      res.json({
        ok: true,
        docId: unpacked.docId,
        totalPages: unpacked.totalPages,
        pageUrlTemplate: `/api/pdf/${unpacked.docId}/page/{page}`,
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'PDF 解包失败' });
    }
  });

  // 解包上传的本地 PDF 二进制为逐页 PNG 图片
  app.post('/api/pdf/unpack-upload', async (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: '上传过于频繁，请稍后重试' });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '未授权上传' });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.byteLength === 0) {
      res.status(400).json({ ok: false, error: '上传内容为空（请以 application/pdf 二进制发送）' });
      return;
    }
    if (buf.byteLength > PDF_UPLOAD_MAX_BYTES) {
      res.status(413).json({ ok: false, error: `PDF 文件超过 ${PDF_UPLOAD_MAX_LABEL} 上限` });
      return;
    }
    try {
      const unpacked = await unpackPdfBufferToPages(buf);
      res.json({
        ok: true,
        docId: unpacked.docId,
        totalPages: unpacked.totalPages,
        pageUrlTemplate: `/api/pdf/${unpacked.docId}/page/{page}`,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'PDF 解包失败' });
    }
  });

  app.get('/api/pdf/:id/meta', (req, res) => {
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '未授权访问 PDF 元数据' });
      return;
    }
    const meta = getUnpackedPdfMeta(String(req.params.id || ''));
    if (!meta) {
      res.status(404).json({ ok: false, error: '未找到已解包的 PDF 文档' });
      return;
    }
    res.json({ ok: true, ...meta });
  });

  app.get('/api/pdf/:id/page/:page', async (req, res) => {
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '未授权访问 PDF 页面' });
      return;
    }
    const docId = String(req.params.id || '');
    const pageNum = Number(req.params.page);
    try {
      const hit = await getUnpackedPdfPage(docId, pageNum, req.query.dpi);
      if (!hit) {
        res.status(404).json({ ok: false, error: '未找到对应 PDF 页面图片' });
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(hit.buffer);
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'PDF 页面渲染失败' });
    }
  });

  app.get('/api/pdf/:id', (req, res) => {
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: '未授权访问 PDF 文件' });
      return;
    }
    const id = String(req.params.id || '');
    const item = uploadedPdfStore.get(id);
    if (!item) {
      res.status(404).json({ ok: false, error: 'PDF 不存在或已过期' });
      return;
    }
    // Map 按插入顺序迭代，只 delete+set 才能把命中项移到队尾，实现真正的 LRU；
    // 否则淘汰的永远是「最早上传」而不是「最久未访问」的那份。
    uploadedPdfStore.delete(id);
    uploadedPdfStore.set(id, item);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${item.filename}"`);
    res.send(item.buf);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, '../dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // 请求体解析类错误（典型是 express.raw 超限）发生在进入路由之前，
  // 不接住的话用户只会看到 Express 默认的 HTML 错误页。
  // 注册在所有路由与静态资源之后，只兜底未被处理的错误，并统一改成 JSON。
  app.use(
    (
      err: (Error & { type?: string; status?: number }) | null,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!err) {
        next();
        return;
      }
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err.type === 'entity.too.large') {
        res.status(413).json({ ok: false, error: `PDF 文件大小需在 1B–${PDF_UPLOAD_MAX_LABEL} 之间` });
        return;
      }
      const status = typeof err.status === 'number' ? err.status : 500;
      res.status(status).json({ ok: false, error: err.message || '服务端处理失败' });
    }
  );

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Atlas Hybrid Canvas] running at http://localhost:${PORT}`);
    console.log(`[Atlas Hybrid Canvas] 协同房间 WebSocket: ws://localhost:${PORT}/ws`);
  });

  // 房间服务与 Express 共用同一个 HTTP server 与端口，靠 upgrade 事件按 /ws 分流。
  roomServer = attachRoomServer(httpServer, '/ws', makeRpcHandler(PORT), DATA_DIR, verifyProxyClientToken, (rp) => roomBlueprintRegistry.getStore(rp));

  const shutdown = () => {
    void roomServer!.close().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void startServer();
