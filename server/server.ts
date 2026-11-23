import 'dotenv/config';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPrivateOrReservedIP,
  parseAllowedHosts,
  PROXY_DEFAULT_TIMEOUT_MS,
  sanitizeProxyHeaders,
  readResponseBufferWithLimit,
  sanitizeBinaryProxyContentType,
  validateProxyTargetUrl,
} from './proxySecurity';
import {
  getUnpackedPdfMeta,
  getUnpackedPdfPage,
  unpackPdfBufferToPages,
} from './pdfUnpack';
import { attachRoomServer, type RoomServerHandle, type RpcHandler } from './roomServer';
import {
  createMemoryStore,
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

// 权威底座存储。业务逻辑在 apiCore 里，这里只提供存储实现。
const sharedStore = createMemoryStore();

// 房间服务实例。必须在 httpServer 建好之后才能 attach，而 stats 路由又要注册在
// SPA fallback 之前，所以用模块级变量在注册时先捕获引用、attach 后再赋值。
let roomServer: RoomServerHandle | null = null;

/** 这些响应头没必要回传给浏览器，传了反而可能干扰。 */
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
      const bodyBuf = frame.body
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
            done({
              t: 'rpc_res',
              id: frame.id,
              status: res.statusCode ?? 502,
              headers: resHeaders,
              body: buf.toString('base64'),
              bodyEncoding: 'base64',
            });
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
  app.get('/api/room/stats', (_req, res) => {
    if (!roomServer) {
      res.status(503).json({ ok: false, error: '房间服务尚未就绪' });
      return;
    }
    res.json({ ok: true, ...roomServer.stats(), rpcForwarded });
  });

  const blueprintSaveKey = (process.env.BLUEPRINT_SAVE_KEY || '').trim();
  const upstreamBaseUrl = (process.env.PROXY_UPSTREAM_BASE_URL || '').trim();
  const allowedHosts = parseAllowedHosts(process.env.PROXY_ALLOWED_HOSTS);
  const proxyApiKey = (process.env.PROXY_API_KEY || '').trim();
  const proxyClientToken = (process.env.PROXY_CLIENT_TOKEN || '').trim();
  const proxyRateLimitPerMin = Math.max(1, Number(process.env.PROXY_RATE_LIMIT_PER_MIN || 30));
  const proxyRateHits = new Map<string, number[]>();

  const verifyProxyClientToken = (provided: string): boolean => {
    if (!proxyClientToken) return true;
    if (!provided) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(proxyClientToken, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  };

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
  const serverFetcher: HttpFetcher = {
    async fetch(url, init) {
      // a) 目标 URL 形状与白名单（复用 proxySecurity，别在这里重写一份）
      const target = validateProxyTargetUrl(url, { upstreamBaseUrl, allowedHosts });
      if (!target.ok) throw new Error(target.error);

      // b) DNS 解析后逐个检查是否内网/元数据地址。
      //    必须在真正发请求前查，因为 parse URL 阶段拿到的只是域名字符串，
      //    域名可以解析到 127.0.0.1 或 169.254.169.254。
      const lookupHost = target.url.hostname.replace(/^\[|\]$/g, '');
      const records = await dns.lookup(lookupHost, { all: true });
      if (records.length === 0) throw new Error('目标域名解析失败');
      for (const rec of records) {
        if (isPrivateOrReservedIP(rec.address)) {
          throw new Error('安全限制：目标域名解析到受保护的内网或元数据地址，已拒绝代理');
        }
      }

      // c) 头净化（去掉 Host / Cookie 这类不该透传的）
      const headerCheck = sanitizeProxyHeaders(init.headers);
      if (!headerCheck.ok) throw new Error(headerCheck.error);

      // d) 按配置注入上游密钥。调用方自己带了同名头就不覆盖。
      const outboundHeaders: Record<string, string> = { ...headerCheck.headers };
      if (proxyApiKey && target.injectSecret) {
        const hasClientOverride = Object.keys(outboundHeaders).some(
          (k) => k.toLowerCase() === proxyApiKeyHeader.toLowerCase()
        );
        if (!hasClientOverride) {
          outboundHeaders[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
        }
      }

      // e) 发请求。redirect: manual —— 3xx 由 apiCore 统一拦截，
      //    因为跟随后续跳转可能落到白名单之外。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROXY_DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(target.url.toString(), {
          method: init.method,
          headers: outboundHeaders,
          // 包一层 Buffer：Node 的 fetch 接受 Buffer，而 Uint8Array 在 TS 的类型
          // 定义里不被认作合法 BodyInit（实际运行时没问题，这里只是取悦类型）。
          body: init.body ? Buffer.from(init.body) : undefined,
          redirect: 'manual',
          signal: controller.signal,
        });
        const read = await readResponseBufferWithLimit(res, 2 * 1024 * 1024);
        if (!read.ok) {
          throw new Error('上游响应体超过 2MB 安全上限，已中止读取');
        }
        const buf = new Uint8Array(read.buffer);
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });
        return { status: res.status, headers: resHeaders, body: buf };
      } finally {
        clearTimeout(timer);
      }
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
      clientId: req.ip || req.socket.remoteAddress || 'unknown',
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
    const provided = String(req.header('x-proxy-token') || (isBinaryRoute ? req.query.token || '' : '')).trim();
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
  for (const path of [
    '/api/blueprint',
    '/api/blueprint/publish',
    '/api/proxy/status',
    '/api/proxy',
  ]) {
    app.all(path, async (req, res) => {
      const result = await handleApiRequest(apiDeps, toApiRequest(req));
      if (!result) {
        res.status(404).json({ ok: false, error: `未实现的接口：${path}` });
        return;
      }
      writeApiResult(res, result);
    });
  }

  // 2.5) 二进制 PDF 代理转发与上传托管（复用同套 SSRF、限流与可选令牌鉴权）
  const uploadedPdfStore = new Map<string, { filename: string; buf: Buffer; createdAt: number }>();
  const MAX_UPLOADED_PDFS = 20;

  app.get('/api/proxy/binary', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `代理请求过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
      return;
    }
    const providedProxyToken = String(req.header('x-proxy-token') || req.query.token || '').trim();
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
    try {
      const records = await dns.lookup(target.url.hostname.replace(/^\[|\]$/g, ''), { all: true });
      if (records.length === 0 || records.some((r) => isPrivateOrReservedIP(r.address))) {
        res.status(403).json({ ok: false, error: '安全限制：目标域名解析到受保护地址' });
        return;
      }
    } catch {
      res.status(502).json({ ok: false, error: '目标域名解析失败' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (proxyApiKey && target.injectSecret) {
        headers[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
      }
      // redirect: 'manual' 必须显式指定。Node fetch 默认跟随跳转，白名单上游返回 302 指向
      // 127.0.0.1 / 169.254.169.254 时会在 fetch 内部完成跳转，前面那轮 dns.lookup 校验对
      // 跳转后的地址完全无效 —— SSRF 由此绕过。/api/proxy 早已这么做了，binary 分支此前漏了。
      const upstream = await fetch(target.url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        res.status(502).json({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' });
        return;
      }
      // 流式读并累计字节，超限立刻中断。原先 arrayBuffer() 全量读入再比大小，
      // 恶意大响应在比对之前就已经把内存吃满了。
      // 这里不把 timer 的 controller 传进去：那个 controller 一 abort，下面的 catch 就会
      // 把「超限」误报成「代理拉取失败」。readResponseBufferWithLimit 内部自己 cancel 流即可。
      const read = await readResponseBufferWithLimit(upstream, PDF_UPLOAD_MAX_BYTES);
      if (!read.ok) {
        res.status(413).json({ ok: false, error: `PDF 文件超过 ${PDF_UPLOAD_MAX_LABEL} 代理上限` });
        return;
      }
      // 上游 Content-Type 不可全信：透传 text/html 或 image/svg+xml 配合 inline 会在同源执行脚本。
      res.setHeader('Content-Type', sanitizeBinaryProxyContentType(upstream.headers.get('content-type')));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.status(upstream.status).send(read.buffer);
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'PDF 代理拉取失败' });
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/api/pdf/upload', (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: '上传过于频繁，请稍后重试' });
      return;
    }
    const providedProxyToken = String(req.header('x-proxy-token') || '').trim();
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
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `请求过于频繁，请 ${rl.retryAfterSec} 秒后重试` });
      return;
    }
    const providedProxyToken = String(req.header('x-proxy-token') || '').trim();
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
    try {
      const records = await dns.lookup(target.url.hostname.replace(/^\[|\]$/g, ''), { all: true });
      if (records.length === 0 || records.some((r) => isPrivateOrReservedIP(r.address))) {
        res.status(403).json({ ok: false, error: '安全限制：目标域名解析到受保护地址' });
        return;
      }
    } catch {
      res.status(502).json({ ok: false, error: '目标域名解析失败' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (proxyApiKey && target.injectSecret) {
        headers[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
      }
      const upstream = await fetch(target.url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        res.status(502).json({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' });
        return;
      }
      if (!upstream.ok) {
        res.status(502).json({ ok: false, error: `拉取 PDF 失败（HTTP ${upstream.status}）` });
        return;
      }
      // 独立限流读取，不传入超时 controller，避免超限时 fetch 抛 AbortError 被误判为 502
      const readRes = await readResponseBufferWithLimit(upstream, PDF_UPLOAD_MAX_BYTES);
      if (!readRes.ok) {
        res.status(413).json({ ok: false, error: `PDF 文件超过 ${PDF_UPLOAD_MAX_LABEL} 上限` });
        return;
      }
      const unpacked = await unpackPdfBufferToPages(readRes.buffer);
      res.json({
        ok: true,
        docId: unpacked.docId,
        totalPages: unpacked.totalPages,
        pageUrlTemplate: `/api/pdf/${unpacked.docId}/page/{page}`,
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'PDF 解包失败' });
    } finally {
      clearTimeout(timer);
    }
  });

  // 解包上传的本地 PDF 二进制为逐页 PNG 图片
  app.post('/api/pdf/unpack-upload', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: '上传过于频繁，请稍后重试' });
      return;
    }
    const providedProxyToken = String(req.header('x-proxy-token') || '').trim();
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
    const meta = getUnpackedPdfMeta(String(req.params.id || ''));
    if (!meta) {
      res.status(404).json({ ok: false, error: '未找到已解包的 PDF 文档' });
      return;
    }
    res.json({ ok: true, ...meta });
  });

  app.get('/api/pdf/:id/page/:page', async (req, res) => {
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
  roomServer = attachRoomServer(httpServer, '/ws', makeRpcHandler(PORT));

  const shutdown = () => {
    void roomServer!.close().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void startServer();
