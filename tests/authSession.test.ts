import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSignedSessionToken, verifySignedSessionToken } from '../server/authSession.ts';

test('issueSignedSessionToken() & verifySignedSessionToken() validate signature and subject', () => {
  const secret = 'atlas-test-secret-key-2026';
  const now = 1_700_000_000_000;
  const token = issueSignedSessionToken(secret, 'user-alice', 300, now);

  const ok = verifySignedSessionToken(secret, token, now + 60_000);
  assert.deepEqual(ok, { valid: true, sub: 'user-alice' });

  // 篡改负载或错误密钥必须拒绝
  const tampered = `x${token.slice(1)}`;
  assert.deepEqual(verifySignedSessionToken(secret, tampered, now + 60_000), { valid: false });
  assert.deepEqual(verifySignedSessionToken('wrong-secret', token, now + 60_000), { valid: false });
});

test('verifySignedSessionToken() rejects expired tokens', () => {
  const secret = 'atlas-test-secret-key-2026';
  const now = 1_700_000_000_000;
  const token = issueSignedSessionToken(secret, 'user-bob', 60, now);

  assert.deepEqual(verifySignedSessionToken(secret, token, now + 59_000), { valid: true, sub: 'user-bob' });
  assert.deepEqual(verifySignedSessionToken(secret, token, now + 60_000), { valid: false });
});
