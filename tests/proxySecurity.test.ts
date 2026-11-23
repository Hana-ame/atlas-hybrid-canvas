import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateOrReservedIP,
  parseAllowedHosts,
  sanitizeProxyHeaders,
  readResponseBufferWithLimit,
  sanitizeBinaryProxyContentType,
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

test('isPrivateOrReservedIP() blocks IPv4-mapped IPv6, 0.0.0.0, and CGNAT 100.64.0.0/10', () => {
  for (const ip of ['0.0.0.0', '100.64.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::']) {
    assert.equal(isPrivateOrReservedIP(ip), true, `Expected ${ip} to be blocked`);
  }
});

test('validateProxyTargetUrl() injects secret ONLY for matching upstreamBaseUrl origin, never arbitrary allowlisted hosts', () => {
  const allowed = parseAllowedHosts('httpbin.org');
  const upstreamMatch = validateProxyTargetUrl('/v1/chat', {
    upstreamBaseUrl: 'https://api.internal-upstream.example.com',
    allowedHosts: allowed,
  });
  assert.equal(upstreamMatch.ok, true);
  if (upstreamMatch.ok) assert.equal(upstreamMatch.injectSecret, true);

  const thirdParty = validateProxyTargetUrl('https://httpbin.org/get', {
    upstreamBaseUrl: 'https://api.internal-upstream.example.com',
    allowedHosts: allowed,
  });
  assert.equal(thirdParty.ok, true);
  if (thirdParty.ok) assert.equal(thirdParty.injectSecret, false);
});

test('readResponseBufferWithLimit: rejects oversized Content-Length before reading body', async () => {
  const controller = new AbortController();
  const fakeRes = new Response('hello', {
    headers: { 'content-length': '9999' },
  });
  const res = await readResponseBufferWithLimit(fakeRes, 100, controller);
  assert.equal(res.ok, false);
  assert.equal(controller.signal.aborted, true);
});

test('readResponseBufferWithLimit: aborts stream mid-flight when chunks exceed limit', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(60));
      c.enqueue(new Uint8Array(60));
      c.close();
    },
  });
  const fakeRes = new Response(stream);
  const res = await readResponseBufferWithLimit(fakeRes, 100, controller);
  assert.equal(res.ok, false);
  assert.equal(controller.signal.aborted, true);
});

test('sanitizeBinaryProxyContentType: blocks text/html XSS and defaults to application/pdf', () => {
  assert.equal(sanitizeBinaryProxyContentType('text/html; charset=utf-8'), 'application/pdf');
  assert.equal(sanitizeBinaryProxyContentType('image/svg+xml'), 'application/pdf');
  assert.equal(sanitizeBinaryProxyContentType('application/pdf; charset=binary'), 'application/pdf');
  assert.equal(sanitizeBinaryProxyContentType('application/octet-stream'), 'application/octet-stream');
});

test('validateProxyTargetUrl() never falls back to allowedHosts when upstreamBaseUrl is set but unparsable', () => {
  // upstreamHost 在解析失败时退化成空串；若用 upstreamHost 做「是否配了上游」的判据，
  // 配置写错的部署会静默回落白名单分支，把 PROXY_API_KEY 重新发给 httpbin.org。
  const allowed = parseAllowedHosts('httpbin.org');
  const thirdParty = validateProxyTargetUrl('https://httpbin.org/get', {
    upstreamBaseUrl: 'not a url',
    allowedHosts: allowed,
  });
  assert.equal(thirdParty.ok, true, '白名单主机仍可代理，只是不得携带密钥');
  if (thirdParty.ok) assert.equal(thirdParty.injectSecret, false, '上游配置非法时不得回落注入密钥');

  const arbitrary = validateProxyTargetUrl('https://evil.example.com/x', {
    upstreamBaseUrl: 'not a url',
  });
  assert.equal(arbitrary.ok, true);
  if (arbitrary.ok) assert.equal(arbitrary.injectSecret, false);

  // 完全未配置 upstreamBaseUrl 时才按白名单语义放行密钥
  const legacy = validateProxyTargetUrl('https://httpbin.org/get', { allowedHosts: allowed });
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.equal(legacy.injectSecret, true);
});

test('sanitizeBinaryProxyContentType() pins everything to pdf/octet-stream, blocking inline HTML & SVG XSS', () => {
  // 上游 Content-Type 不可全信：text/html 或 image/svg+xml 配合 Content-Disposition: inline
  // 会在同源执行脚本。白名单之外一律收敛成 application/pdf。
  for (const evil of [
    'text/html',
    'text/html; charset=utf-8',
    'image/svg+xml',
    'text/xml',
    'application/xhtml+xml',
    'application/javascript',
  ]) {
    assert.equal(sanitizeBinaryProxyContentType(evil), 'application/pdf', `${evil} 必须被收敛`);
  }
  assert.equal(sanitizeBinaryProxyContentType('application/pdf'), 'application/pdf');
  assert.equal(sanitizeBinaryProxyContentType('APPLICATION/OCTET-STREAM'), 'application/octet-stream');
  assert.equal(sanitizeBinaryProxyContentType(null), 'application/pdf');
  assert.equal(sanitizeBinaryProxyContentType(''), 'application/pdf');
});

test('readResponseBufferWithLimit() trusts no Content-Length and still aborts an oversized stream', async () => {
  // Content-Length 缺失时不能跳过限额：仍要按流式累加判断
  const noLen = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(80));
      c.enqueue(new Uint8Array(80));
      c.close();
    },
  });
  const res = new Response(noLen, { headers: {} });
  const out = await readResponseBufferWithLimit(res, 100);
  assert.equal(out.ok, false, '超限流必须被拒');

  // 未超限时应原样返回完整字节
  const small = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(30));
      c.enqueue(new Uint8Array(30));
      c.close();
    },
  });
  const ok = await readResponseBufferWithLimit(new Response(small), 100);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.buffer.byteLength, 60);
});
