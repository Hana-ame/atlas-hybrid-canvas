/**
 * @file authSession.ts
 * @description 零外部依赖的无状态 HMAC-SHA256 签名会话令牌签发与校验工具。
 * 用于生产环境替代构建期静态公开的 VITE_PROXY_CLIENT_TOKEN，支持短时效过期与恒定时间签名比对。
 */

import crypto from 'node:crypto';

export interface SignedSessionPayload {
  sub: string;
  exp: number;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): Buffer | null {
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/** 签发带过期时间的 HMAC-SHA256 会话令牌。 */
export function issueSignedSessionToken(
  secret: string,
  subject: string,
  ttlSec = 3600,
  nowMs = Date.now()
): string {
  const safeTtl = Math.max(1, Math.floor(ttlSec));
  const payload: SignedSessionPayload = {
    sub: String(subject || 'anonymous').slice(0, 120),
    exp: Math.floor(nowMs / 1000) + safeTtl,
  };
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${toBase64Url(sig)}`;
}

/** 校验签名与过期时间（使用 timingSafeEqual 防时序侧信道）。 */
export function verifySignedSessionToken(
  secret: string,
  token: string,
  nowMs = Date.now()
): { valid: true; sub: string } | { valid: false } {
  if (!secret || !token) return { valid: false };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { valid: false };

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const providedSig = fromBase64Url(sigB64);
  if (!providedSig) return { valid: false };

  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  if (providedSig.length !== expectedSig.length) return { valid: false };
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return { valid: false };

  const payloadBuf = fromBase64Url(payloadB64);
  if (!payloadBuf) return { valid: false };
  try {
    const parsed = JSON.parse(payloadBuf.toString('utf8')) as Partial<SignedSessionPayload>;
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) {
      return { valid: false };
    }
    if (Math.floor(nowMs / 1000) >= parsed.exp) {
      return { valid: false };
    }
    return { valid: true, sub: parsed.sub };
  } catch {
    return { valid: false };
  }
}
