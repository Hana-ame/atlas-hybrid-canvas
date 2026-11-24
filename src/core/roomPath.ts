/**
 * @file roomPath.ts
 * @description 按 URL 路径划分多房间的统一规范化与路由工具（前后端共用）。
 *
 * 支持的访问形态：
 * - 浏览器地址栏：`/team/design`、`/r/team/design`、`/room/alpha`、`/`（默认房间 `atlas-main`）
 * - WebSocket 房间：`ws://host/ws/team/design?cid=xxx`（同时向后兼容 `ws://host/ws?room=team/design&cid=xxx`）
 * - 蓝图 REST API：`/api/rooms/team/design/blueprint`、`/api/rooms/team/design/blueprint/publish`
 */

export const DEFAULT_ROOM_PATH = 'atlas-main';
const MAX_ROOM_PATH_LEN = 120;

/**
 * 规范化房间路径：
 * - 去掉首尾斜杠、解码 URL 片段、拦截 `.` / `..` 路径遍历；
 * - 保留多级路径语义（如 `team/design`）；
 * - 空路径统一回落到 `atlas-main`。
 */
export function normalizeRoomPath(raw: string | null | undefined): string {
  const input = String(raw ?? '').trim();
  if (!input) return DEFAULT_ROOM_PATH;

  const rawSegments = input.split('/');
  const cleanSegments: string[] = [];

  for (const seg of rawSegments) {
    if (!seg) continue;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg;
    }
    const trimmed = decoded.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') continue;
    // 允许字母、数字、点、下划线、连字符及中文等常见标识字符，过滤控制字符与危险符号
    const safe = trimmed.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!safe || safe === '.' || safe === '..') continue;
    cleanSegments.push(safe);
  }

  if (cleanSegments.length === 0) return DEFAULT_ROOM_PATH;
  const joined = cleanSegments.join('/').slice(0, MAX_ROOM_PATH_LEN).replace(/\/+$/, '');
  return joined || DEFAULT_ROOM_PATH;
}

/**
 * 从浏览器地址解析当前房间路径：
 * - 若部署在子路径（如 GitHub Pages `/<repo>/`），优先读取 `?room=<path>`，并自动剥离 `basePath` 前缀避免把仓库名当成房间名；
 * - 根路径 `/` 或 `/index.html` 统一返回 `atlas-main`。
 */
export function extractRoomPathFromBrowserLocation(
  pathname: string,
  basePath = '/',
  search = ''
): string {
  if (search) {
    try {
      const q = new URLSearchParams(search).get('room');
      if (q && q.trim()) return normalizeRoomPath(q);
    } catch {
      // ignore invalid search
    }
  }
  let clean = String(pathname || '/').trim() || '/';
  const normBase = ('/' + String(basePath || '/').replace(/^\/+|\/+$/g, '') + '/').replace(/\/+/g, '/');
  if (normBase !== '/') {
    const baseNoTrail = normBase.slice(0, -1);
    if (clean === baseNoTrail || clean === normBase || clean === `${normBase}index.html`) {
      return DEFAULT_ROOM_PATH;
    }
    if (clean.startsWith(normBase)) {
      clean = '/' + clean.slice(normBase.length);
    }
  }
  if (!clean || clean === '/' || clean === '/index.html') return DEFAULT_ROOM_PATH;
  const stripped = clean.replace(/^\/(?:r|room)(?=\/)/i, '');
  return normalizeRoomPath(stripped);
}

/** 构造同步浏览器地址栏的 URL（子路径部署用 `?room=` 保底避免刷新 404，根部署直出 `/<roomPath>`）。 */
export function buildBrowserRoomUrl(
  roomPath: string,
  basePath = '/',
  search = '',
  hash = ''
): string {
  const normalized = normalizeRoomPath(roomPath);
  const normBase = ('/' + String(basePath || '/').replace(/^\/+|\/+$/g, '') + '/').replace(/\/+/g, '/');
  const params = new URLSearchParams(search);
  if (normBase !== '/') {
    if (normalized === DEFAULT_ROOM_PATH) params.delete('room');
    else params.set('room', normalized);
    const qs = params.toString();
    return `${normBase}${qs ? `?${qs}` : ''}${hash}`;
  }
  params.delete('room');
  const qs = params.toString();
  const targetPath = normalized === DEFAULT_ROOM_PATH ? '/' : `/${encodeRoomPathForUrl(normalized)}`;
  return `${targetPath}${qs ? `?${qs}` : ''}${hash}`;
}

/**
 * 从 WebSocket 握手路径解析房间路径：
 * - 匹配 `/ws/<roomPath>` -> 返回规范化后的 `<roomPath>`；
 * - 匹配 `/ws`（无子路径）-> 兼容旧版 `?room=<name>`（若也未传则返回 null，由调用方拒连或用默认）；
 * - 不匹配 `wsPrefix` -> 返回 `null`（非房间 WS 路径）。
 */
export function extractRoomPathFromWsPathname(
  pathname: string,
  wsPrefix = '/ws',
  queryRoom?: string | null
): { matched: boolean; roomPath: string | null } {
  const prefix = wsPrefix.endsWith('/') && wsPrefix.length > 1 ? wsPrefix.slice(0, -1) : wsPrefix;
  const cleanPath = String(pathname || '/');

  if (cleanPath === prefix || cleanPath === `${prefix}/`) {
    const q = String(queryRoom ?? '').trim();
    if (!q) return { matched: true, roomPath: null };
    return { matched: true, roomPath: normalizeRoomPath(q) };
  }

  if (cleanPath.startsWith(`${prefix}/`)) {
    const sub = cleanPath.slice(prefix.length + 1);
    if (!sub.trim()) return { matched: true, roomPath: null };
    return { matched: true, roomPath: normalizeRoomPath(sub) };
  }

  return { matched: false, roomPath: null };
}

/** 将多级房间路径按段做 URI 编码（保留 `/` 分隔符）。 */
export function encodeRoomPathForUrl(roomPath: string): string {
  return normalizeRoomPath(roomPath)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * 构造按 path 分房间的 WebSocket 建连地址：
 * 例如 `ws://localhost:8787/ws` + `team/design` + `c1`
 * -> `ws://localhost:8787/ws/team/design?cid=c1`
 */
export function buildRoomWsUrl(baseWsUrl: string, roomPath: string, cid: string): string {
  const trimmed = baseWsUrl.trim();
  const normalized = normalizeRoomPath(roomPath);
  const encodedPath = encodeRoomPathForUrl(normalized);

  try {
    const u = new URL(trimmed);
    const basePath = u.pathname.replace(/\/+$/, '') || '/ws';
    u.pathname = `${basePath}/${encodedPath}`;
    u.searchParams.delete('room');
    u.searchParams.set('cid', cid);
    return u.toString();
  } catch {
    const cleanBase = trimmed.replace(/\/+$/, '');
    const sep = cleanBase.includes('?') ? '&' : '?';
    return `${cleanBase}/${encodedPath}${sep}cid=${encodeURIComponent(cid)}`;
  }
}

export function buildRoomBlueprintUrl(roomPath: string): string {
  return `/api/rooms/${encodeRoomPathForUrl(roomPath)}/blueprint`;
}

export function buildRoomBlueprintPublishUrl(roomPath: string): string {
  return `/api/rooms/${encodeRoomPathForUrl(roomPath)}/blueprint/publish`;
}

export function buildRoomHistoryUrl(roomPath: string): string {
  return `/api/rooms/${encodeRoomPathForUrl(roomPath)}/history`;
}

export function buildRoomRollbackUrl(roomPath: string): string {
  return `/api/rooms/${encodeRoomPathForUrl(roomPath)}/rollback`;
}
