/**
 * @file runtimeConfig.ts
 * @description 后端地址与运行模式的单一判定点。
 *
 * 规则只有一条，其余模块都从这里读，不要各自去摸 import.meta.env：
 *
 *   VITE_BACKEND_WS_URL 未配置  →  纯静态模式：/api/* 由浏览器内 mock 处理，无协同房间
 *   VITE_BACKEND_WS_URL 已配置  →  连后端模式：协同房间连这个地址
 *
 * 为什么不给个 localhost 默认值：GitHub Pages 是静态托管，任何写死的 localhost
 * 在线上都指向"访问者自己的电脑"，必然连不上。与其给个看着能用、实际永远失败的
 * 默认值，不如空着、让 UI 明确显示"当前是演示模式"。
 *
 * 开发态（npm run dev）例外：同一个进程既提供 API 又提供房间，所以 defaultRoomWsUrl()
 * 会回落到本机 8787，让开箱即用。
 */

const RAW_BACKEND_WS_URL = String((import.meta.env ?? {} as Record<string, string | undefined>).VITE_BACKEND_WS_URL ?? '').trim();
const RAW_FORCE_BACKEND_PROXY = String(
  (import.meta.env ?? {} as Record<string, string | undefined>).VITE_FORCE_BACKEND_PROXY ?? ''
).trim();

/** 解析是否强制走后端 /api/proxy 的配置值；默认 true，设为 false/0/off/no 时放行直接 CORS/同源请求。 */
export function parseForceBackendProxy(raw: string | undefined): boolean {
  const norm = String(raw ?? '').trim().toLowerCase();
  if (norm === 'false' || norm === '0' || norm === 'off' || norm === 'no') {
    return false;
  }
  return true;
}

/** 当前构建是否默认强制走后端 /api/proxy（Docker 部署可配置为 false 以直连同源或 CORS 接口）。 */
export function forceBackendProxy(): boolean {
  return parseForceBackendProxy(RAW_FORCE_BACKEND_PROXY);
}

/** 结合单项显式覆盖与全局默认值，判定本次请求是否应走 /api/proxy。 */
export function shouldUseBackendProxy(explicit?: boolean): boolean {
  return explicit !== undefined ? Boolean(explicit) : forceBackendProxy();
}

/** 把用户填的地址规整成合法的 ws:// 或 wss:// URL；不合法返回 null。 */
export function normalizeWsUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 允许只填域名，自动补 wss://，减少填错概率
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^wss?:\/\//i.test(trimmed)) {
    return null;
  }
  const withScheme = /^wss?:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    return url.toString();
  } catch {
    return null;
  }
}

/** 是否配置了外部后端。所有"要不要走真服务端"的判断都用这个，不要重复判断字符串。 */
export function hasBackend(): boolean {
  return normalizeWsUrl(RAW_BACKEND_WS_URL) !== null;
}

/**
 * 协同房间的默认地址。
 *
 * - 配置了 VITE_BACKEND_WS_URL：用它。
 * - 没配置但处于开发态：回落到 ws://localhost:8787/ws —— 此时 npm run dev 起的
 *   同一个进程就带着房间服务，开箱即用。
 * - 没配置且是生产构建：返回空字符串，UI 应显示"演示模式，协同不可用"。
 */
export function defaultRoomWsUrl(): string {
  const configured = normalizeWsUrl(RAW_BACKEND_WS_URL);
  if (configured) return configured;
  if ((import.meta.env ?? {} as Record<string, string | undefined>).DEV) {
    const { protocol, hostname } = window.location;
    // dev 端口默认 8787；若 Vite 被配到别的端口，这里仍按 8787 回退，
    // 因为 server/server.ts 的 PORT 默认值就是 8787，两边对齐。
    void protocol;
    return `ws://${hostname || 'localhost'}:8787/ws`;
  }
  return '';
}
