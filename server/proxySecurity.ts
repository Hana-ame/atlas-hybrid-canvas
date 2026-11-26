import net from 'node:net';

export const PROXY_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'host',
  'origin',
  'referer',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
]);

export const PROXY_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export const PROXY_MAX_RESPONSE_CHARS = 256 * 1024;
export const PROXY_DEFAULT_TIMEOUT_MS = 10_000;


function bigIntToIpv4(n: bigint): string {
  return `${(n >> 24n) & 0xffn}.${(n >> 16n) & 0xffn}.${(n >> 8n) & 0xffn}.${n & 0xffn}`;
}

function parseIpv6ToBigInt(raw: string): bigint | null {
  const noZone = raw.split('%')[0];
  let work = noZone;
  const lastColon = work.lastIndexOf(':');
  if (lastColon !== -1 && work.slice(lastColon + 1).includes('.')) {
    const octets = parseIpv4Octets(work.slice(lastColon + 1));
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = work.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  let val = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    val = (val << 16n) | BigInt(parseInt(g, 16));
  }
  return val;
}

function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * Returns true if an IPv4 or IPv6 address belongs to a loopback, private, link-local,
 * carrier-grade NAT, multicast, unspecified, or cloud-metadata range.
 */
export function isPrivateOrReservedIP(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;

  const version = net.isIP(ip);
  if (version === 4) {
    const o = parseIpv4Octets(ip);
    if (!o) return true;
    const [a, b] = o;
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 10) return true; // 10.0.0.0/8 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF protocol
    if (a === 192 && b === 0 && o[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
    return false;
  }

  if (version === 6) {
    const v6 = parseIpv6ToBigInt(ip);
    if (v6 === null) return true;
    // ::/128 (unspecified) & ::1/128 (loopback)
    if (v6 === 0n || v6 === 1n) return true;
    // ::ffff:0:0/96 (IPv4-mapped) & ::/96 (IPv4-compatible)
    if ((v6 >> 32n) === 0xffffn || (v6 >> 32n) === 0n) {
      const v4 = bigIntToIpv4(v6 & 0xffffffffn);
      return isPrivateOrReservedIP(v4);
    }
    // 64:ff9b::/96 (NAT64 well-known prefix)
    if ((v6 >> 32n) === 0x0064ff9b0000000000000000n) {
      return isPrivateOrReservedIP(bigIntToIpv4(v6 & 0xffffffffn));
    }
    // 2002::/16 (6to4 embedding IPv4 in bits 16..47)
    if ((v6 >> 112n) === 0x2002n) {
      return isPrivateOrReservedIP(bigIntToIpv4((v6 >> 80n) & 0xffffffffn));
    }
    // 100::/64 (Discard-Only)
    if ((v6 >> 64n) === 0x0100000000000000n) return true;
    // fc00::/7 (Unique local), fe80::/10 (Link-local), ff00::/8 (Multicast)
    const top16 = Number(v6 >> 112n);
    if ((top16 & 0xfe00) === 0xfc00) return true;
    if ((top16 & 0xffc0) === 0xfe80) return true;
    if ((top16 & 0xff00) === 0xff00) return true;
    return false;
  }

  // Non-IP strings shouldn't be treated as public IPs
  return true;
}

/**
 * Parses a comma-separated host allowlist from environment configuration.
 */
export function parseAllowedHosts(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Checks if `hostname` matches an allowlist entry (exact host or subdomain match).
 */
export function hostMatchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host || allowlist.length === 0) return false;
  return allowlist.some((allowed) => allowed === '*' || host === allowed || host.endsWith(`.${allowed}`));
}

export interface ProxyTargetValidationResult {
  ok: true;
  url: URL;
  injectSecret: boolean;
}

export interface ProxyTargetValidationError {
  ok: false;
  status: number;
  error: string;
}

/**
 * Validates a target URL for the server-side `/api/proxy` route.
 * - Resolves relative `/...` paths against `upstreamBaseUrl` when configured.
 * - Restricts schemes strictly to `http:` / `https:`.
 * - Rejects embedded credentials, localhost/internal hostnames, and private/metadata IPs.
 * - Enforces `allowedHosts` when configured.
 * - Authorizes server-side secret header injection (`injectSecret`) with these rules:
 *   - If `upstreamBaseUrl` is configured, ONLY that exact host receives the secret;
 *     allowlisted third-party hosts stay proxyable but never receive it.
 *   - If `upstreamBaseUrl` is NOT configured, fall back to `allowedHosts` (legacy behaviour).
 */
export function validateProxyTargetUrl(
  rawUrl: string,
  config: {
    upstreamBaseUrl?: string;
    allowedHosts?: readonly string[];
  } = {}
): ProxyTargetValidationResult | ProxyTargetValidationError {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    return { ok: false, status: 400, error: '缺少目标请求 URL' };
  }
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, status: 400, error: 'URL 包含非法控制字符' };
  }

  let resolvedStr = trimmed;
  let upstreamHost = '';
  const upstreamBase = (config.upstreamBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (upstreamBase) {
    try {
      upstreamHost = new URL(upstreamBase).hostname.toLowerCase();
    } catch {
      upstreamHost = '';
    }
  }

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    if (!upstreamBase) {
      return {
        ok: false,
        status: 400,
        error: '服务端尚未配置 PROXY_UPSTREAM_BASE_URL，相对路径暂不可用（请输入完整 https:// 地址或在环境变量中配置上游地址）',
      };
    }
    resolvedStr = `${upstreamBase}${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(resolvedStr);
  } catch {
    return { ok: false, status: 400, error: '目标 URL 格式无效' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: 400, error: '服务端代理仅支持 http:// 或 https:// 协议' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: 400, error: '禁止在 URL 中嵌入账号密码凭证' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.goog'
  ) {
    return { ok: false, status: 403, error: '安全限制：禁止服务端代理访问本机或内网域名' };
  }

  if (net.isIP(host) !== 0 && isPrivateOrReservedIP(host)) {
    return { ok: false, status: 403, error: '安全限制：禁止服务端代理访问内网、回环或元数据 IP 地址' };
  }

  const allowedHosts = config.allowedHosts ?? [];
  const effectiveAllowlist = upstreamHost
    ? Array.from(new Set([...allowedHosts, upstreamHost]))
    : [...allowedHosts];

  if (effectiveAllowlist.length === 0) {
    return {
      ok: false,
      status: 403,
      error: '安全限制：服务端未配置代理白名单 (PROXY_ALLOWED_HOSTS / PROXY_UPSTREAM_BASE_URL)，已拒绝开放代理',
    };
  }

  if (!hostMatchesAllowlist(host, effectiveAllowlist)) {
    return {
      ok: false,
      status: 403,
      error: `安全限制：目标域名 ${host} 不在服务端允许代理的白名单 (PROXY_ALLOWED_HOSTS) 内`,
    };
  }

  // When upstreamBaseUrl is configured, inject PROXY_API_KEY strictly to upstreamHost only
  // (never leak upstream secrets to unrelated third-party hosts such as httpbin.org in allowedHosts).
  // 注意：判「是否配置了上游」必须看 upstreamBase 原始字符串，不能看 upstreamHost。
  // upstreamHost 在上游 URL 解析失败时会退化成空串，若用它做判据，配置写错的部署会静默回落到
  // allowedHosts 分支，把密钥重新发给 httpbin.org 这类演示域名 —— 正是要堵的那个洞。
  const injectSecret = upstreamBase
    ? host === upstreamHost // upstreamHost 为空时恒为 false，即配置非法时不向任何主机注入
    : allowedHosts.some((allowed) => allowed !== '*' && (host === allowed || host.endsWith(`.${allowed}`)));

  return {
    ok: true,
    url: parsed,
    injectSecret,
  };
}

/**
 * Filters client-supplied headers before forwarding through `/api/proxy`.
 */
export function sanitizeProxyHeaders(
  rawHeaders: unknown
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const clean: Record<string, string> = {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return { ok: true, headers: clean };
  }
  for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (/[\r\n\0]/.test(key) || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) {
      return { ok: false, error: `无效的请求头名称：${key}` };
    }
    const lower = key.toLowerCase();
    if (
      PROXY_FORBIDDEN_HEADERS.has(lower) ||
      lower.startsWith('sec-') ||
      lower.startsWith('proxy-')
    ) {
      return { ok: false, error: `安全限制：禁止转发受保护请求头 ${key}` };
    }
    const val = typeof v === 'string' ? v : String(v ?? '');
    if (/[\r\n\0]/.test(val)) {
      return { ok: false, error: `请求头 ${key} 包含非法换行符` };
    }
    clean[key] = val;
  }
  return { ok: true, headers: clean };
}

export type BoundedReadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; tooLarge: true };

/**
 * 流式读取上游二进制响应并强制执行字节上限，避免大响应先全量落内存导致 OOM。
 */
export async function readResponseBufferWithLimit(
  response: Pick<Response, 'headers' | 'body' | 'arrayBuffer'>,
  maxBytes: number,
  controller?: AbortController
): Promise<{ ok: true; buffer: Buffer } | { ok: false; tooLarge: true }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller?.abort();
    await response.body?.cancel().catch(() => {});
    return { ok: false, tooLarge: true };
  }

  if (!response.body) {
    const arr = Buffer.from(await response.arrayBuffer());
    if (arr.byteLength > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, buffer: arr };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller?.abort();
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

/**
 * 限制 /api/proxy/binary 下发的 Content-Type，防止上游返回 text/html 造成同源 XSS。
 */
export function sanitizeBinaryProxyContentType(raw: string | null): string {
  const normalized = (raw || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'application/pdf' || normalized === 'application/octet-stream') {
    return normalized;
  }
  return 'application/pdf';
}
