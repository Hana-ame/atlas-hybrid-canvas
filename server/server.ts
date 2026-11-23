import 'dotenv/config';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPrivateOrReservedIP,
  parseAllowedHosts,
  PROXY_ALLOWED_METHODS,
  PROXY_DEFAULT_TIMEOUT_MS,
  PROXY_MAX_RESPONSE_CHARS,
  sanitizeProxyHeaders,
  validateProxyTargetUrl,
} from './proxySecurity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// 权威底座内存存储（生产环境可替换为 SQLite / PostgreSQL + PostGIS）
let serverBaseBlueprint: Record<string, unknown> | null = null;
let serverRevision = 1;

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  // PDF 上传走 base64 JSON，15MB 原始字节编码后约 20.0MB（膨胀 4/3），
  // 若 limit 取 20mb 会与 PDF 自身上限撞在边界上，导致正好 15MB 的文件被 express 直接 413、
  // 连 /api/pdf/upload 里的友好提示都到不了。这里留足余量到 24mb。
  app.use(express.json({ limit: '24mb' }));

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
  app.get('/api/blueprint', (_req, res) => {
    res.json({
      ok: true,
      serverRevision,
      blueprint: serverBaseBlueprint,
    });
  });

  const verifySaveKey = (provided: string): boolean => {
    if (!blueprintSaveKey || !provided) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(blueprintSaveKey, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  };

  app.post('/api/blueprint/publish', (req, res) => {
    if (!blueprintSaveKey) {
      res.status(403).json({
        ok: false,
        error: '服务端未配置 BLUEPRINT_SAVE_KEY，已禁止保存；普通用户仅可通过控件内置 API 访问后端',
      });
      return;
    }
    const providedKey = String(req.header('x-blueprint-save-key') || '').trim();
    if (!verifySaveKey(providedKey)) {
      res.status(401).json({
        ok: false,
        error: '保存密钥（Save Key）错误或缺失；无密钥仅可使用控件内预设 API，本地修改已保留在浏览器',
      });
      return;
    }
    const body = req.body as { blueprint?: Record<string, unknown> } | null;
    if (!body || !body.blueprint || typeof body.blueprint !== 'object') {
      res.status(400).json({ ok: false, error: '无效的蓝图数据' });
      return;
    }
    serverBaseBlueprint = body.blueprint;
    serverRevision += 1;
    res.json({ ok: true, serverRevision });
  });

  // 2) 防 SSRF 服务端密钥代理（复用自 AtlasCanvas）
  app.get('/api/proxy/status', (_req, res) => {
    res.json({
      enabled: true,
      hasUpstreamSecret: Boolean(proxyApiKey),
      allowedHosts,
    });
  });

  app.post('/api/proxy', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 10));
      res.status(429).json({
        ok: false,
        error: `代理请求过于频繁（上限 ${proxyRateLimitPerMin} 次/分钟），请 ${rl.retryAfterSec} 秒后重试`,
      });
      return;
    }

    const providedProxyToken = String(req.header('x-proxy-token') || '').trim();
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({
        ok: false,
        error: '代理调用未授权：缺少或错误的 X-Proxy-Token',
      });
      return;
    }

    const body = req.body as {
      url?: unknown;
      method?: unknown;
      headers?: unknown;
      body?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ ok: false, error: '请求体格式无效' });
      return;
    }

    const method = typeof body.method === 'string' ? body.method.toUpperCase().trim() : 'POST';
    if (!PROXY_ALLOWED_METHODS.has(method)) {
      res.status(400).json({ ok: false, error: `不支持的 HTTP 方法：${method}` });
      return;
    }

    const target = validateProxyTargetUrl(String(body.url ?? ''), {
      upstreamBaseUrl,
      allowedHosts,
    });
    if (!target.ok) {
      res.status(target.status).json({ ok: false, error: target.error });
      return;
    }

    try {
      const records = await dns.lookup(target.url.hostname, { all: true });
      if (records.length === 0) {
        res.status(502).json({ ok: false, error: '目标域名解析失败' });
        return;
      }
      for (const rec of records) {
        if (isPrivateOrReservedIP(rec.address)) {
          res.status(403).json({
            ok: false,
            error: '安全限制：目标域名解析到受保护的内网或元数据地址，已拒绝代理',
          });
          return;
        }
      }
    } catch {
      res.status(502).json({ ok: false, error: '无法解析目标服务器域名' });
      return;
    }

    const headerCheck = sanitizeProxyHeaders(body.headers);
    if (!headerCheck.ok) {
      res.status(400).json({ ok: false, error: headerCheck.error });
      return;
    }

    const outboundHeaders: Record<string, string> = { ...headerCheck.headers };
    if (proxyApiKey && target.injectSecret) {
      const hasClientOverride = Object.keys(outboundHeaders).some(
        (k) => k.toLowerCase() === proxyApiKeyHeader.toLowerCase()
      );
      if (!hasClientOverride) {
        outboundHeaders[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_DEFAULT_TIMEOUT_MS);

    try {
      const init: RequestInit = {
        method,
        headers: outboundHeaders,
        redirect: 'manual',
        signal: controller.signal,
      };
      if (method !== 'GET' && typeof body.body === 'string') {
        init.body = body.body;
      }

      const upstreamRes = await fetch(target.url.toString(), init);
      if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
        res.status(502).json({ ok: false, error: '安全限制：已拦截上游 3xx 重定向' });
        return;
      }

      const contentType = upstreamRes.headers.get('content-type') || '';
      const fullText = await upstreamRes.text();
      const rawText =
        fullText.length > PROXY_MAX_RESPONSE_CHARS
          ? `${fullText.slice(0, PROXY_MAX_RESPONSE_CHARS)}\n…(响应已截断至 256KB)`
          : fullText;

      let responseBody: unknown = rawText;
      if (contentType.toLowerCase().includes('application/json')) {
        try {
          responseBody = JSON.parse(rawText);
        } catch {
          responseBody = rawText;
        }
      }

      res.status(200).json({
        ok: upstreamRes.ok,
        status: upstreamRes.status,
        responseBody,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      res.status(isAbort ? 504 : 502).json({
        ok: false,
        error: isAbort ? '服务端代理请求超时（10s）' : '服务端代理请求失败',
      });
    } finally {
      clearTimeout(timer);
    }
  });

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
      const records = await dns.lookup(target.url.hostname, { all: true });
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
      const upstream = await fetch(target.url.toString(), { method: 'GET', headers, signal: controller.signal });
      const arr = Buffer.from(await upstream.arrayBuffer());
      if (arr.byteLength > 15 * 1024 * 1024) {
        res.status(413).json({ ok: false, error: 'PDF 文件超过 15MB 代理上限' });
        return;
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      res.status(upstream.status).send(arr);
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
    const body = req.body as { filename?: unknown; base64?: unknown } | null;
    const base64 = typeof body?.base64 === 'string' ? body.base64.trim() : '';
    if (!base64) {
      res.status(400).json({ ok: false, error: '缺少 PDF 数据' });
      return;
    }
    const buf = Buffer.from(base64, 'base64');
    if (buf.byteLength === 0 || buf.byteLength > 15 * 1024 * 1024) {
      res.status(413).json({ ok: false, error: 'PDF 文件大小需在 1B–15MB 之间' });
      return;
    }
    if (buf.subarray(0, 4).toString('ascii') !== '%PDF') {
      res.status(400).json({ ok: false, error: '文件头校验失败，仅允许标准 PDF 文件' });
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const filename = String(body?.filename || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    if (uploadedPdfStore.size >= MAX_UPLOADED_PDFS) {
      const oldestKey = uploadedPdfStore.keys().next().value;
      if (oldestKey) uploadedPdfStore.delete(oldestKey);
    }
    uploadedPdfStore.set(id, { filename, buf, createdAt: Date.now() });
    res.json({ ok: true, id, url: `/api/pdf/${id}` });
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Atlas Hybrid Canvas] running at http://localhost:${PORT}`);
  });
}

void startServer();
