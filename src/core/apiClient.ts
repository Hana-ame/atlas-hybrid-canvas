/**
 * @file apiClient.ts
 * @description 前端调用 /api/* 时统一补上 X-Proxy-Token 的工具。
 *
 * 背景：服务端的 verifyProxyClientToken() 在 PROXY_CLIENT_TOKEN 为空时放行所有调用方，
 * 一旦配置了 token，前端此前从不发送该头，所有代理/上传/解包请求会直接 401 —— 于是
 * "设 token 就不可用、不设 token 就匿名开放"成了一个死结。
 *
 * 这里把 token 从 VITE_PROXY_CLIENT_TOKEN 注入前端（构建期常量，非机密；真正的机密
 * 始终只在服务端），三个调用点统一走 proxyHeaders()，避免各处漏加。
 */
const CLIENT_TOKEN = String(import.meta.env.VITE_PROXY_CLIENT_TOKEN || '').trim();

/** 合并业务需要的头，并在配置了 token 时补上 X-Proxy-Token。 */
export function proxyHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (CLIENT_TOKEN) headers['X-Proxy-Token'] = CLIENT_TOKEN;
  return headers;
}

/** 为无法附带自定义请求头的 <img> 资源 URL（如 /api/pdf/:id/page/:page）在配置了 token 时追加 token 查询参数。 */
export function appendProxyTokenQuery(url: string): string {
  if (!CLIENT_TOKEN || !url) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(CLIENT_TOKEN)}`;
}
