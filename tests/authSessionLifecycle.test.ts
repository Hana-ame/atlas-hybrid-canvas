import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendProxyTokenQuery,
  getActiveProxyToken,
  getAuthSessionState,
  proxyHeaders,
  refreshAuthSession,
  setRuntimeProxyToken,
  stopAuthSessionRefresh,
} from '../src/core/apiClient.ts';
import { issueSignedSessionToken, verifySignedSessionToken } from '../server/authSession.ts';

test('refreshAuthSession exchanges signed token, deduplicates concurrent calls, and populates headers/query', async () => {
  setRuntimeProxyToken('');
  stopAuthSessionRefresh();

  const secret = 'proxy-fallback-secret-01';
  const signed = issueSignedSessionToken(secret, 'atlas-web', 120);
  assert.equal(verifySignedSessionToken(secret, signed).valid, true);

  let callCount = 0;
  const mockFetch: typeof fetch = (async () => {
    callCount += 1;
    await new Promise((r) => setTimeout(r, 15));
    return new Response(
      JSON.stringify({ ok: true, token: signed, expiresInSec: 120, mode: 'signed' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const [t1, t2] = await Promise.all([
    refreshAuthSession({ fetchImpl: mockFetch, scheduleNext: false }),
    refreshAuthSession({ fetchImpl: mockFetch, scheduleNext: false }),
  ]);

  assert.equal(callCount, 1);
  assert.equal(t1, signed);
  assert.equal(t2, signed);
  assert.equal(getActiveProxyToken(), signed);
  assert.equal(getAuthSessionState().hasRuntimeToken, true);
  assert.equal(proxyHeaders({ 'X-Custom': '1' })['X-Proxy-Token'], signed);
  assert.ok(appendProxyTokenQuery('/api/pdf/doc1/page/1').includes(`token=${encodeURIComponent(signed)}`));

  setRuntimeProxyToken('');
  stopAuthSessionRefresh();
});

test('refreshAuthSession degrades gracefully on open mode or HTTP error without throwing', async () => {
  setRuntimeProxyToken('');
  stopAuthSessionRefresh();

  const failFetch: typeof fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  const t = await refreshAuthSession({ fetchImpl: failFetch, scheduleNext: false });
  assert.equal(t, '');
  assert.equal(getAuthSessionState().hasRuntimeToken, false);
});
