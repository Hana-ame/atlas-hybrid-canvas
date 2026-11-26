/**
 * @file apiPoller.ts
 * @description API 轮询抓取纯逻辑工具：
 * - 轮询间隔安全夹紧（2s–3600s，防 0/负数/NaN 刷爆接口）；
 * - 目标 URL 安全校验（仅放行 http/https 外链与同源 `/` 相对路径，拒绝 `//` 及 javascript:/data:/file:）；
 * - 防原型链污染的 JSON 路径提取（支持 dot 路径与数组下标 items[0].name）；
 * - 连续失败指数退避计算（上限 5 分钟，成功后立即恢复原间隔）；
 * - 响应安全格式化与截断。
 */

export const MIN_POLL_INTERVAL_SEC = 2;
export const MAX_POLL_INTERVAL_SEC = 3600;
export const DEFAULT_POLL_INTERVAL_SEC = 10;
export const MAX_BACKOFF_DELAY_MS = 5 * 60 * 1000;

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function normalizePollIntervalSec(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_INTERVAL_SEC;
  return Math.max(MIN_POLL_INTERVAL_SEC, Math.min(MAX_POLL_INTERVAL_SEC, n));
}

export function normalizePollMethod(raw: unknown): 'GET' | 'POST' {
  return String(raw || '').trim().toUpperCase() === 'POST' ? 'POST' : 'GET';
}

export function isSafePollUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * 连续失败时的指数退避延迟：
 * errors=0 -> baseIntervalSec * 1000
 * errors=1 -> base * 2, errors=2 -> base * 4 ... 最多 2^4 = 16 倍且封顶 5 分钟。
 */
export function computeBackoffDelayMs(baseIntervalSec: number, consecutiveErrors: number): number {
  const baseMs = normalizePollIntervalSec(baseIntervalSec) * 1000;
  const errCount = Math.max(0, Math.floor(Number(consecutiveErrors) || 0));
  if (errCount === 0) return baseMs;
  const factor = Math.pow(2, Math.min(4, errCount));
  return Math.min(MAX_BACKOFF_DELAY_MS, baseMs * factor);
}

/**
 * 安全提取 JSON 路径，例如 "data.price"、"items[0].title"、"a.b[2].c"。
 * 自动拦截 __proto__ / constructor / prototype 防止原型链逃逸。
 */
export function extractJsonPath(data: unknown, rawPath: string): unknown {
  const path = rawPath.trim();
  if (!path) return data;

  // 严格词法校验：仅允许由点号或 [非负整数] 连接的合法段，拒绝未闭合括号、空段及非数字下标
  if (!/^(?:[^.[\]]+|\[\d+\])(?:\.[^.[\]]+|\[\d+\])*$/.test(path)) return undefined;
  const segments: Array<string | number> = [];
  const tokenRe = /[^.[\]]+|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(path)) !== null) {
    if (match[1] !== undefined) {
      segments.push(Number(match[1]));
    } else {
      const seg = match[0].trim();
      if (!seg) continue;
      if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return undefined;
      segments.push(seg);
    }
  }
  if (segments.length === 0) return undefined;

  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg < 0 || seg >= cur.length) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export function formatPolledValue(value: unknown, maxChars = 4000): string {
  if (value === undefined) return '(未命中字段)';
  if (value === null) return 'null';
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n…(已截断，共 ${text.length} 字符)`;
  }
  return text;
}
