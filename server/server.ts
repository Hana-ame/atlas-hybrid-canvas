import 'dotenv/config';
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
  app.use(express.json({ limit: '2mb' }));

  const upstreamBaseUrl = (process.env.PROXY_UPSTREAM_BASE_URL || '').trim();
  const allowedHosts = parseAllowedHosts(process.env.PROXY_ALLOWED_HOSTS);
  const proxyApiKey = (process.env.PROXY_API_KEY || '').trim();
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

  app.post('/api/blueprint/publish', (req, res) => {
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
