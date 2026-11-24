import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

async function waitForHealth(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('server failed to boot within timeout');
}

test('E2E live server (dist-server/server.mjs): auth session, Origin check, room publish, history, rollback & WS replace sync', async (t) => {
  const tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-e2e-'));
  const port = 18700 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEntry = path.resolve('dist-server/server.mjs');

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      ATLAS_DATA_DIR: tmpDataDir,
      AUTH_SESSION_SECRET: 'e2e-session-secret-01',
      BLUEPRINT_SAVE_KEY: 'e2e-admin-key-01',
      CORS_ALLOWED_ORIGINS: 'https://allowed.example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);

  // 1) Health check
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = (await healthRes.json()) as { ok: boolean; authMode: string };
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.authMode, 'session');

  // 2) Unauthenticated request to room blueprint must be 401
  const unauthRes = await fetch(`${baseUrl}/api/rooms/team/e2e/blueprint`);
  assert.equal(unauthRes.status, 401);

  // 3) Disallowed Origin on /api/auth/session must be 403
  const badOriginRes = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ cid: 'e2e-1' }),
  });
  assert.equal(badOriginRes.status, 403);

  // 4) Valid session request mints HttpOnly cookie + signed token
  const sessRes = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ cid: 'e2e-1' }),
  });
  assert.equal(sessRes.status, 200);
  const setCookie = sessRes.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('atlas_session='), 'should set atlas_session cookie');
  assert.ok(setCookie.includes('HttpOnly'), 'cookie must be HttpOnly');
  const sessJson = (await sessRes.json()) as { ok: boolean; token: string; mode: string };
  assert.equal(sessJson.mode, 'signed');
  const cookieHeader = setCookie.split(';')[0];

  // 5) Publish v1 blueprint using HttpOnly cookie + admin key
  const bpV1 = {
    version: 1,
    chunkSize: 512,
    nodes: { n1: { id: 'n1', rev: 1, cid: 'admin', title: 'Version 1' } },
    annotations: {},
    edges: {},
  };
  const pub1 = await fetch(`${baseUrl}/api/rooms/team/e2e/blueprint/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      'X-Blueprint-Save-Key': 'e2e-admin-key-01',
    },
    body: JSON.stringify({ blueprint: bpV1 }),
  });
  assert.equal(pub1.status, 200);

  // 6) Connect real WS client via Sec-WebSocket-Protocol subprotocol auth (zero URL token)
  const b64url = Buffer.from(sessJson.token, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/team/e2e?cid=ws-e2e-1`, [
    'atlas-v1',
    `atlas-auth.${b64url}`,
  ]);
  const wsFrames: any[] = [];
  ws.on('message', (data) => {
    try {
      wsFrames.push(JSON.parse(String(data)));
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  t.after(() => ws.close());
  assert.equal(ws.protocol, 'atlas-v1');

  // Wait for initial state hydration from unified RoomBlueprintStore
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(
    wsFrames.some((f) => f.t === 'state' && f.blueprint?.nodes?.n1?.title === 'Version 1'),
    'WS client should hydrate v1 from unified RoomBlueprintStore'
  );

  // 7) Publish v2 adding n2, then verify history has [2, 1]
  const bpV2 = {
    version: 2,
    chunkSize: 512,
    nodes: {
      n1: { id: 'n1', rev: 2, cid: 'admin', title: 'Version 2' },
      n2: { id: 'n2', rev: 1, cid: 'admin', title: 'Extra Node' },
    },
    annotations: {},
    edges: {},
  };
  const pub2 = await fetch(`${baseUrl}/api/rooms/team/e2e/blueprint/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      'X-Blueprint-Save-Key': 'e2e-admin-key-01',
    },
    body: JSON.stringify({ blueprint: bpV2 }),
  });
  assert.equal(pub2.status, 200);

  const histRes = await fetch(`${baseUrl}/api/rooms/team/e2e/history`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(histRes.status, 200);
  const histJson = (await histRes.json()) as { ok: boolean; entries: Array<{ version: number }> };
  assert.deepEqual(
    histJson.entries.map((e) => e.version),
    [2, 1]
  );

  // 8) Rollback to v1 -> verify REST returns v1 AND WS client receives replace: true without n2
  wsFrames.length = 0;
  const rbRes = await fetch(`${baseUrl}/api/rooms/team/e2e/rollback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      'X-Blueprint-Save-Key': 'e2e-admin-key-01',
    },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(rbRes.status, 200);

  const afterRest = await fetch(`${baseUrl}/api/rooms/team/e2e/blueprint`, {
    headers: { Cookie: cookieHeader },
  });
  const afterJson = (await afterRest.json()) as { blueprint: { nodes: Record<string, any> } };
  assert.equal(afterJson.blueprint.nodes.n1.title, 'Version 1');
  assert.equal('n2' in afterJson.blueprint.nodes, false);

  await new Promise((r) => setTimeout(r, 150));
  const replaceFrame = wsFrames.find((f) => f.t === 'state' && f.replace === true);
  assert.ok(replaceFrame, 'WS client should receive replace: true state frame on rollback');
  assert.equal(replaceFrame.blueprint.nodes.n1.title, 'Version 1');
  assert.equal('n2' in replaceFrame.blueprint.nodes, false);
});

test('E2E security regressions (P0-1 empty Origin, P1-1 XFF rate-limit spoofing, P1-2 proxy secret decoupling, P2-4 logical room list)', async (t) => {
  const tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-e2e-sec-'));
  const port = 19700 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEntry = path.resolve('dist-server/server.mjs');

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      ATLAS_DATA_DIR: tmpDataDir,
      AUTH_SESSION_SECRET: 'e2e-sec-session-secret',
      BLUEPRINT_SAVE_KEY: 'e2e-sec-admin-key',
      PROXY_API_KEY: 'upstream-secret-never-for-anon',
      PROXY_ACCESS_KEY: 'e2e-proxy-access-key',
      PROXY_RATE_LIMIT_PER_MIN: '3',
      TRUST_PROXY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);

  // P0-1: Missing Origin header on /api/auth/session MUST be rejected (403)
  const noOriginRes = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cid: 'curl-attacker' }),
  });
  assert.equal(noOriginRes.status, 403, 'empty Origin must not mint a session token');

  // Mint one legitimate same-origin session token
  const sessRes = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ cid: 'legit-browser' }),
  });
  assert.equal(sessRes.status, 200);
  const sessJson = (await sessRes.json()) as { token: string };

  // P1-2: Anonymous session token alone MUST NOT access /api/proxy when PROXY_API_KEY / PROXY_ACCESS_KEY is configured
  const anonProxyRes = await fetch(`${baseUrl}/api/proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Token': sessJson.token,
    },
    body: JSON.stringify({ url: 'https://httpbin.org/get', method: 'GET' }),
  });
  assert.equal(anonProxyRes.status, 401, 'anonymous session token must not borrow PROXY_API_KEY');

  // With valid X-Proxy-Access-Key, auth passes (downstream host check or request proceeds; non-allowlisted host returns 403 from allowlist, not 401)
  const authedProxyRes = await fetch(`${baseUrl}/api/proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Access-Key': 'e2e-proxy-access-key',
    },
    body: JSON.stringify({ url: 'https://blocked.invalid/test', method: 'GET' }),
  });
  assert.equal(authedProxyRes.status, 403, 'valid X-Proxy-Access-Key should pass auth and hit allowlist check');

  // P2-4: Publish a nested room and verify GET /api/rooms returns logical roomPath
  const pubRes = await fetch(`${baseUrl}/api/rooms/team/design/blueprint/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Token': sessJson.token,
      'X-Blueprint-Save-Key': 'e2e-sec-admin-key',
    },
    body: JSON.stringify({ blueprint: { version: 1, chunkSize: 512, nodes: {}, annotations: {}, edges: {} } }),
  });
  assert.equal(pubRes.status, 200);

  const roomsRes = await fetch(`${baseUrl}/api/rooms`, {
    headers: { 'X-Proxy-Token': sessJson.token },
  });
  assert.equal(roomsRes.status, 200);
  const roomsJson = (await roomsRes.json()) as { ok: boolean; persisted: string[] };
  assert.ok(roomsJson.persisted.includes('team/design'), `expected logical roomPath team/design, got ${JSON.stringify(roomsJson.persisted)}`);

  // P1-1: Spoofing X-Forwarded-For with TRUST_PROXY=false MUST NOT bypass rate limit (limit=3; 2 hits already used on /api/auth/session)
  let hit429 = false;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
        'X-Forwarded-For': `203.0.113.${10 + i}`,
      },
      body: JSON.stringify({ cid: `spoof-${i}` }),
    });
    if (r.status === 429) {
      hit429 = true;
      break;
    }
  }
  assert.equal(hit429, true, 'spoofed X-Forwarded-For must not bypass PROXY_RATE_LIMIT_PER_MIN');
});
