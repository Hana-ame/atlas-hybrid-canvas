import { proxyHeaders } from './apiClient';
import { isSafePollUrl } from './apiPoller';
import { shouldUseBackendProxy } from './runtimeConfig';
import type { WidgetButtonSpec } from './types';

export interface HttpButtonResult {
  ok: boolean;
  usedProxy: boolean;
  status?: number;
  responseBody?: unknown;
  error?: string;
}

/**
 * 执行 HTTP 按钮动作：
 * - 当 `useProxy`（或全局 `VITE_FORCE_BACKEND_PROXY`）为 true 且非 `/api/` 路径时走 `/api/proxy`；
 * - 否则直接在浏览器发起同源或 CORS `fetch`（支持 GET/POST 与可选 `proxyBody`）。
 */
export async function executeHttpButtonAction(
  btn: Pick<WidgetButtonSpec, 'proxyUrl' | 'proxyMethod' | 'proxyBody' | 'useProxy'>,
  fetchImpl: typeof fetch = fetch
): Promise<HttpButtonResult> {
  const targetUrl = String(btn.proxyUrl ?? '').trim();
  const method = btn.proxyMethod || 'GET';
  const rawBody = method === 'POST' && typeof btn.proxyBody === 'string' ? btn.proxyBody : '';
  const hasBody = rawBody.trim().length > 0;
  const usedProxy = !targetUrl.startsWith('/api/') && shouldUseBackendProxy(btn.useProxy);

  if (!targetUrl) {
    return { ok: false, usedProxy, error: '未填写请求 URL' };
  }

  if (usedProxy) {
    try {
      const resp = await fetchImpl('/api/proxy', {
        method: 'POST',
        headers: proxyHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          url: targetUrl,
          method,
          ...(hasBody ? { body: rawBody } : {}),
        }),
      });
      let data: { ok?: boolean; status?: number; responseBody?: unknown; error?: string };
      try {
        data = (await resp.json()) as { ok?: boolean; status?: number; responseBody?: unknown; error?: string };
      } catch {
        return {
          ok: false,
          usedProxy: true,
          status: resp.status,
          error: `HTTP ${resp.status}（响应非 JSON）`,
        };
      }
      if (!resp.ok || data.ok === false) {
        return {
          ok: false,
          usedProxy: true,
          status: data.status ?? resp.status,
          responseBody: data.responseBody,
          error: data.error || `HTTP ${data.status ?? resp.status}`,
        };
      }
      return {
        ok: true,
        usedProxy: true,
        status: data.status ?? 200,
        responseBody: data.responseBody,
      };
    } catch (err) {
      return {
        ok: false,
        usedProxy: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!isSafePollUrl(targetUrl)) {
    return { ok: false, usedProxy: false, error: '仅支持 http/https 外链或同源相对路径' };
  }

  try {
    const trimmedBody = rawBody.trim();
    const baseHeaders = targetUrl.startsWith('/api/') ? proxyHeaders() : {};
    const reqHeaders: Record<string, string> = { ...baseHeaders };
    if (hasBody) {
      reqHeaders['Content-Type'] =
        trimmedBody.startsWith('{') || trimmedBody.startsWith('[')
          ? 'application/json'
          : 'text/plain; charset=utf-8';
    }
    const resp = await fetchImpl(targetUrl, {
      method,
      ...(Object.keys(reqHeaders).length > 0 ? { headers: reqHeaders } : {}),
      ...(hasBody ? { body: rawBody } : {}),
    });
    const rawText = await resp.text();
    let parsedBody: unknown = rawText;
    if (rawText) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = rawText;
      }
    }
    if (!resp.ok) {
      return {
        ok: false,
        usedProxy: false,
        status: resp.status,
        responseBody: parsedBody,
        error: `HTTP ${resp.status}`,
      };
    }
    return {
      ok: true,
      usedProxy: false,
      status: resp.status,
      responseBody: parsedBody,
    };
  } catch (err) {
    return {
      ok: false,
      usedProxy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
