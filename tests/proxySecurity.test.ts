import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateOrReservedIP,
  parseAllowedHosts,
  sanitizeProxyHeaders,
  validateProxyTargetUrl,
} from '../server/proxySecurity.ts';

test('isPrivateOrReservedIP() blocks loopback, RFC1918, cloud metadata, and IPv6 ULA', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isPrivateOrReservedIP(ip), true, `Expected ${ip} to be blocked`);
  }
  assert.equal(isPrivateOrReservedIP('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIP('1.1.1.1'), false);
});

test('validateProxyTargetUrl() enforces HTTPS/HTTP allowlist and blocks localhost', () => {
  const allowed = parseAllowedHosts('api.github.com,httpbin.org');
  const ok = validateProxyTargetUrl('https://httpbin.org/get', { upstreamBaseUrl: '', allowedHosts: allowed });
  assert.equal(ok.ok, true);

  const badLocal = validateProxyTargetUrl('http://127.0.0.1:8080/admin', { upstreamBaseUrl: '', allowedHosts: allowed });
  assert.equal(badLocal.ok, false);

  const badHost = validateProxyTargetUrl('https://evil.example.com/steal', { upstreamBaseUrl: '', allowedHosts: allowed });
  assert.equal(badHost.ok, false);
});

test('sanitizeProxyHeaders() rejects forbidden hop-by-hop/Cookie headers and allows safe custom headers', () => {
  const blocked = sanitizeProxyHeaders({ Host: 'evil.com', Cookie: 'session=abc' });
  assert.equal(blocked.ok, false);

  const ok = sanitizeProxyHeaders({ 'Content-Type': 'application/json', 'X-Custom': 'ok' });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.headers['X-Custom'], 'ok');
  }
});
