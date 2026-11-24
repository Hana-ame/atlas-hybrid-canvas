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

test('E2E Agent Ops: GET /api/agent/schema, authenticated POST /api/rooms/*/ops, live WS sync & history audit', async (t) => {
  const tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-e2e-agent-'));
  const port = 20700 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEntry = path.resolve('dist-server/server.mjs');

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      ATLAS_DATA_DIR: tmpDataDir,
      AUTH_SESSION_SECRET: 'e2e-agent-session-secret',
      BLUEPRINT_SAVE_KEY: 'e2e-agent-admin-key',
      AGENT_API_KEY: 'e2e-dedicated-agent-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);

  const schemaRes = await fetch(`${baseUrl}/api/agent/schema`);
  assert.equal(schemaRes.status, 200);
  const schemaJson = (await schemaRes.json()) as { ok: boolean; tools: Array<{ name: string }> };
  assert.equal(schemaJson.ok, true);
  assert.ok(schemaJson.tools.some((t) => t.name === 'atlas_canvas_ops') && schemaJson.tools.some((t) => t.name === 'atlas_inspect_room'));

  const unauthOps = await fetch(`${baseUrl}/api/rooms/team/agent/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops: [{ op: 'create_widget', title: 'No Auth' }] }),
  });
  assert.equal(unauthOps.status, 401);

  const sessRes = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ cid: 'human-viewer' }),
  });
  const sessJson = (await sessRes.json()) as { token: string };
  const b64url = Buffer.from(sessJson.token, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/team/agent?cid=human-viewer`, [
    'atlas-v1',
    `atlas-auth.${b64url}`,
  ]);
  const frames: any[] = [];
  ws.on('message', (d) => {
    try { frames.push(JSON.parse(String(d))); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  t.after(() => ws.close());

  const opsRes = await fetch(`${baseUrl}/api/rooms/team/agent/ops`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Api-Key': 'e2e-dedicated-agent-key',
    },
    body: JSON.stringify({
      actor: 'claude-planner',
      summary: '创建监控区背景与两个联动控件',
      ops: [
        { op: 'create_annotation', id: 'bg-1', kind: 'text', text: '监控分区', bgColor: '#FEF3C7', x: 20, y: 20, width: 760, height: 420 },
        { op: 'create_widget', id: 'w-1', title: 'CPU 指标', defaultVars: { usage: 42 } },
        { op: 'create_widget', id: 'w-2', title: '告警卡片' },
        { op: 'connect_edge', id: 'e-1', source: 'w-1', target: 'w-2', label: '阈值触发' },
      ],
    }),
  });
  assert.equal(opsRes.status, 200);
  const opsJson = (await opsRes.json()) as { ok: boolean; room: string; historyVersion: number; results: any[] };
  assert.equal(opsJson.ok, true);
  assert.equal(opsJson.room, 'team/agent');
  assert.equal(opsJson.results.length, 4);

  await new Promise((r) => setTimeout(r, 150));
  assert.ok(
    frames.some((f) => f.t === 'state' && f.replace === true && f.blueprint?.nodes?.['w-1']?.title === 'CPU 指标' && f.blueprint?.annotations?.['bg-1']?.text === '监控分区'),
    'connected WS client must receive Agent ops in real time'
  );

  const histRes = await fetch(`${baseUrl}/api/rooms/team/agent/history`, {
    headers: { 'X-Proxy-Token': sessJson.token },
  });
  const histJson = (await histRes.json()) as { ok: boolean; entries: Array<{ action: string; actor: string }> };
  assert.equal(histJson.ok, true);
  assert.equal(histJson.entries[0].action, 'agent');
  assert.equal(histJson.entries[0].actor, 'claude-planner');
});

test('E2E Agent v88: preserves unflushed human WS edit, supports agent/state, dryRun, expectedRevision 409, template ops & live MCP', async (t) => {
  const { handleMcpJsonRpcRequest } = await import('../server/mcpServer.ts');
  const tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-e2e-v88-'));
  const port = 21700 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEntry = path.resolve('dist-server/server.mjs');

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      ATLAS_DATA_DIR: tmpDataDir,
      AUTH_SESSION_SECRET: 'e2e-v88-session-secret',
      BLUEPRINT_SAVE_KEY: 'e2e-v88-admin-key',
      AGENT_API_KEY: 'e2e-v88-agent-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);

  const sessRes = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ cid: 'human-live' }),
  });
  const sessJson = (await sessRes.json()) as { token: string };
  const b64url = Buffer.from(sessJson.token, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/team/live?cid=human-live`, [
    'atlas-v1',
    `atlas-auth.${b64url}`,
  ]);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  t.after(() => ws.close());

  ws.send(JSON.stringify({
    t: 'upsert_node',
    node: {
      id: 'human-node-1',
      x: 50,
      y: 50,
      width: 280,
      height: 160,
      title: '人类刚刚拖出来的节点',
      body: '',
      color: '#10B981',
      defaultVars: {},
      rev: 1,
      cid: 'human-live',
    },
  }));
  await new Promise((r) => setTimeout(r, 80));

  const stateRes = await fetch(`${baseUrl}/api/rooms/team/live/agent/state`, {
    headers: { 'X-Agent-Api-Key': 'e2e-v88-agent-key' },
  });
  assert.equal(stateRes.status, 200);
  const stateJson = (await stateRes.json()) as { ok: boolean; revision: number; summary: { nodes: Array<{ id: string }> } };
  assert.equal(stateJson.ok, true);
  assert.ok(
    stateJson.summary.nodes.some((n) => n.id === 'human-node-1'),
    'Agent state must immediately see unflushed human WS edit'
  );

  const dryRes = await fetch(`${baseUrl}/api/rooms/team/live/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Api-Key': 'e2e-v88-agent-key' },
    body: JSON.stringify({
      dryRun: true,
      ops: [{ op: 'create_from_template', templateId: 'tpl-slider-node', id: 'preview-slider' }],
    }),
  });
  assert.equal(dryRes.status, 200);
  const dryJson = (await dryRes.json()) as { dryRun: boolean; currentRevision: number; results: Array<{ bounds: any }> };
  assert.equal(dryJson.dryRun, true);
  assert.ok(dryJson.results[0].bounds, 'dryRun should return computed auto-layout bounds');

  const conflictRes = await fetch(`${baseUrl}/api/rooms/team/live/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Api-Key': 'e2e-v88-agent-key' },
    body: JSON.stringify({
      expectedRevision: stateJson.revision + 99,
      ops: [{ op: 'create_widget', title: 'Should Conflict' }],
    }),
  });
  assert.equal(conflictRes.status, 409);

  const mcpCfg = { baseUrl, apiKey: 'e2e-v88-agent-key', defaultRoom: 'team/live' };
  const mcpOps = await handleMcpJsonRpcRequest(
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'atlas_apply_ops',
        arguments: {
          room: 'team/live',
          expectedRevision: stateJson.revision,
          ops: [{ op: 'create_from_template', templateId: 'tpl-slider-node', id: 'agent-slider-1', title: 'Agent 模板滑块' }],
        },
      },
    },
    mcpCfg
  );
  const mcpOpsData = JSON.parse((mcpOps?.result as any).content[0].text);
  assert.equal(mcpOpsData.ok, true);

  const afterState = await handleMcpJsonRpcRequest(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'atlas_inspect_room', arguments: { room: 'team/live' } } },
    mcpCfg
  );
  const afterData = JSON.parse((afterState?.result as any).content[0].text);
  assert.ok(afterData.summary.nodes.some((n: any) => n.id === 'human-node-1'), 'human WS node must be preserved');
  assert.ok(afterData.summary.nodes.some((n: any) => n.id === 'agent-slider-1'), 'Agent template node must exist');
});
