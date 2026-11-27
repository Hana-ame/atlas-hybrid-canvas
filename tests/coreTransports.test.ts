import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket as NodeWebSocket } from 'ws';
import {
  normalizeWsUrl,
  hasBackend,
  defaultRoomWsUrl,
  parseForceBackendProxy,
  shouldUseBackendProxy,
} from '../src/core/runtimeConfig.ts';
import { executeHttpButtonAction } from '../src/core/httpButton.ts';
import { RpcClient, frameToResponse } from '../src/core/rpcClient.ts';
import { CollaborativeRoomClient } from '../src/core/roomClient.ts';
import { attachRoomServer } from '../server/roomServer.ts';
import { disposeClientPdfDoc, hasClientPdfDoc } from '../src/core/pdfClientUnpack.ts';
import { installMockApi } from '../src/core/mockApi.ts';

test('runtimeConfig: normalizeWsUrl handles ws/wss/http/https and rejects invalid schemes', () => {
  assert.equal(normalizeWsUrl('ws://localhost:8787/ws'), 'ws://localhost:8787/ws');
  assert.equal(normalizeWsUrl('wss://api.example.com/ws/'), 'wss://api.example.com/ws/');
  assert.equal(normalizeWsUrl('http://localhost:8787/ws'), null);
  assert.equal(normalizeWsUrl('javascript:alert(1)'), null);
  assert.equal(normalizeWsUrl('   '), null);
  assert.equal(normalizeWsUrl('/ws', { protocol: 'http:', host: '127.0.0.1:8080' }), 'ws://127.0.0.1:8080/ws');
  assert.equal(normalizeWsUrl('/ws', { protocol: 'https:', host: 'canvas.example.com' }), 'wss://canvas.example.com/ws');
  assert.equal(normalizeWsUrl('auto', { protocol: 'https:', host: 'canvas.example.com:8443' }), 'wss://canvas.example.com:8443/ws');
  assert.equal(normalizeWsUrl('same-origin', { protocol: 'http:', host: 'localhost:8080' }), 'ws://localhost:8080/ws');
  assert.equal(normalizeWsUrl('/ws', null), '/ws');
  assert.equal(normalizeWsUrl('//evil.com/ws', { protocol: 'https:', host: 'canvas.example.com' }), null);
  assert.equal(typeof hasBackend(), 'boolean');
  assert.equal(typeof defaultRoomWsUrl(), 'string');
});

test('rpcClient: frameToResponse decodes text, base64, and native binary rawBody cleanly', async () => {
  const rText = frameToResponse({
    t: 'rpc_res',
    id: '1',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    bodyEncoding: 'text',
  });
  assert.equal(rText.status, 200);
  assert.deepEqual(await rText.json(), { ok: true });

  const rB64 = frameToResponse({
    t: 'rpc_res',
    id: '2',
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from([1, 2, 3, 4]).toString('base64'),
    bodyEncoding: 'base64',
  });
  assert.deepEqual(Array.from(new Uint8Array(await rB64.arrayBuffer())), [1, 2, 3, 4]);

  const rawBytes = new Uint8Array([9, 8, 7, 6]);
  const rBin = frameToResponse({
    t: 'rpc_res',
    id: '3',
    status: 201,
    headers: { 'content-type': 'application/pdf' },
    body: '',
    rawBody: rawBytes,
    bodyEncoding: 'binary',
  });
  assert.equal(rBin.status, 201);
  assert.deepEqual(Array.from(new Uint8Array(await rBin.arrayBuffer())), [9, 8, 7, 6]);
});

test('RpcClient sends native binary & text requests over live WS server and receives matched responses', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const handle = attachRoomServer(server, '/ws', async (frame) => {
    if (frame.bodyEncoding === 'binary' && frame.rawBody) {
      return {
        t: 'rpc_res',
        id: frame.id,
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: '',
        rawBody: new Uint8Array(frame.rawBody.map((b) => b ^ 0xff)),
        bodyEncoding: 'binary',
      };
    }
    return {
      t: 'rpc_res',
      id: frame.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echoedPath: frame.path, method: frame.method }),
      bodyEncoding: 'text',
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const prevWS = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = NodeWebSocket;
  const client = new RpcClient(`ws://127.0.0.1:${port}/ws`);
  t.after(async () => {
    client.close();
    (globalThis as any).WebSocket = prevWS;
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const resText = await client.request({ method: 'GET', path: '/api/health', headers: {}, body: '' });
  assert.equal(resText.status, 200);
  assert.deepEqual(JSON.parse(resText.body), { echoedPath: '/api/health', method: 'GET' });

  const payload = new Uint8Array([0x0f, 0xf0, 0xaa]);
  const resBin = await client.request({ method: 'POST', path: '/api/pdf/upload', headers: {}, body: payload });
  assert.equal(resBin.status, 200);
  assert.equal(resBin.bodyEncoding, 'binary');
  assert.deepEqual(Array.from(resBin.rawBody ?? []), [0xf0, 0x0f, 0x55]);
});

test('CollaborativeRoomClient connects over path URL, flushes offline queue, and deduplicates duplicate frames', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const handle = attachRoomServer(server, '/ws');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const prevWS = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = NodeWebSocket;

  const receivedByB: any[] = [];
  const statusesA: string[] = [];
  const clientA = new CollaborativeRoomClient('cid-a', (s) => statusesA.push(s), () => {});
  const clientB = new CollaborativeRoomClient('cid-b', () => {}, (m) => receivedByB.push(m));

  t.after(async () => {
    clientA.disconnect();
    clientB.disconnect();
    (globalThis as any).WebSocket = prevWS;
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  clientB.connect(`ws://127.0.0.1:${port}/ws`, 'team/collab-test');
  clientA.connect(`ws://127.0.0.1:${port}/ws`, 'team/collab-test');
  const deadline = Date.now() + 2000;
  while (!statusesA.includes('connected') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(statusesA.includes('connected'));

  clientA.send({
    t: 'upsert_node',
    node: { id: 'n-queued', rev: 1, cid: 'cid-a', title: 'Queued' } as any,
  });
  const deadline2 = Date.now() + 2000;
  while (!receivedByB.some((m) => m.t === 'upsert_node' && m.node?.id === 'n-queued') && Date.now() < deadline2) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(receivedByB.some((m) => m.t === 'upsert_node' && m.node?.id === 'n-queued'));
});

test('pdfClientUnpack: hasClientPdfDoc & disposeClientPdfDoc handle unknown doc IDs safely', () => {
  assert.equal(hasClientPdfDoc('non-existent-doc'), false);
  assert.doesNotThrow(() => disposeClientPdfDoc('non-existent-doc'));
});

test('mockApi: installMockApi intercepts /api/* locally in static mode and passes non-/api/ through', async (t) => {
  const passthroughCalls: string[] = [];
  const fakeWindow = {
    location: { href: 'http://localhost:5173/team/demo' },
    fetch: async (input: RequestInfo | URL) => {
      passthroughCalls.push(String(input));
      return new Response('external-ok', { status: 200 });
    },
  };
  const prevWin = (globalThis as any).window;
  (globalThis as any).window = fakeWindow;
  t.after(() => {
    (globalThis as any).window = prevWin;
  });

  installMockApi();

  // 1) /api/auth/session -> local apiCore open mode (zero passthrough)
  const sess = await fakeWindow.fetch('/api/auth/session', { method: 'POST' });
  assert.equal(sess.status, 200);
  const sessJson = (await sess.json()) as { mode: string };
  assert.equal(sessJson.mode, 'open');

  // 2) /api/rooms/team/demo/history -> local fallback (zero passthrough)
  const hist = await fakeWindow.fetch('/api/rooms/team/demo/history');
  assert.equal(hist.status, 200);
  assert.deepEqual(((await hist.json()) as { entries: unknown[] }).entries, []);

  // 3) Non-/api/ URL -> passed through to originalFetch
  const ext = await fakeWindow.fetch('https://example.com/asset.png');
  assert.equal(await ext.text(), 'external-ok');
  assert.deepEqual(passthroughCalls, ['https://example.com/asset.png']);
});

test('mockApi: static mode isolates blueprints per roomPath via getRoomStore (P1-3)', async () => {
  const g = globalThis as any;
  const origWin = g.window;
  const origFetch = g.fetch;
  const fakeWin: any = {
    location: { protocol: 'https:', host: 'pages.example.com', hostname: 'pages.example.com', origin: 'https://pages.example.com', pathname: '/' },
    fetch: async () => new Response('external', { status: 200 }),
  };
  g.window = fakeWin;
  g.fetch = fakeWin.fetch;
  try {
    installMockApi();
    const bpA = { version: 1, chunkSize: 512, nodes: { a: { id: 'a', title: 'Room Alpha' } }, annotations: {}, edges: {} };
    const bpB = { version: 1, chunkSize: 512, nodes: { b: { id: 'b', title: 'Room Beta' } }, annotations: {}, edges: {} };

    const pubA = await fakeWin.fetch('/api/rooms/team/alpha/blueprint/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Blueprint-Save-Key': 'atlas-demo-key' },
      body: JSON.stringify({ blueprint: bpA }),
    });
    assert.equal(pubA.status, 200);

    const pubB = await fakeWin.fetch('/api/rooms/team/beta/blueprint/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Blueprint-Save-Key': 'atlas-demo-key' },
      body: JSON.stringify({ blueprint: bpB }),
    });
    assert.equal(pubB.status, 200);

    const getA = await (await fakeWin.fetch('/api/rooms/team/alpha/blueprint')).json();
    const getB = await (await fakeWin.fetch('/api/rooms/team/beta/blueprint')).json();
    assert.equal(getA.blueprint?.nodes?.a?.title, 'Room Alpha');
    assert.equal(getA.blueprint?.nodes?.b, undefined);
    assert.equal(getB.blueprint?.nodes?.b?.title, 'Room Beta');
    assert.equal(getB.blueprint?.nodes?.a, undefined);
  } finally {
    g.window = origWin;
    g.fetch = origFetch;
  }
});

test('runtimeConfig: parseForceBackendProxy & shouldUseBackendProxy support configurable direct CORS mode', () => {
  assert.equal(parseForceBackendProxy(undefined), true);
  assert.equal(parseForceBackendProxy(''), true);
  assert.equal(parseForceBackendProxy('true'), true);
  assert.equal(parseForceBackendProxy('false'), false);
  assert.equal(parseForceBackendProxy('0'), false);
  assert.equal(parseForceBackendProxy('off'), false);
  assert.equal(parseForceBackendProxy('NO'), false);
  assert.equal(shouldUseBackendProxy(false), false);
  assert.equal(shouldUseBackendProxy(true), true);
});

test('httpButton: executeHttpButtonAction supports direct CORS/same-origin fetch and optional /api/proxy', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown; contentType?: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method,
      body: init?.body,
      contentType: headers.get('content-type') ?? undefined,
    });
    return new Response(JSON.stringify({ ok: true, square: 25 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const directRes = await executeHttpButtonAction(
    {
      proxyUrl: '/math/square',
      proxyMethod: 'POST',
      proxyBody: '{"x":5}',
      useProxy: false,
    },
    fakeFetch
  );
  assert.equal(directRes.ok, true);
  assert.equal(directRes.usedProxy, false);
  assert.equal(directRes.status, 200);
  assert.deepEqual(directRes.responseBody, { ok: true, square: 25 });
  assert.equal(calls[0].url, '/math/square');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].contentType, 'application/json');

  const proxyRes = await executeHttpButtonAction(
    {
      proxyUrl: 'https://api.example.com/hook',
      proxyMethod: 'POST',
      proxyBody: '{"hello":1}',
      useProxy: true,
    },
    fakeFetch
  );
  assert.equal(proxyRes.ok, true);
  assert.equal(proxyRes.usedProxy, true);
  assert.equal(calls[1].url, '/api/proxy');

  const blockedRes = await executeHttpButtonAction(
    {
      proxyUrl: 'javascript:alert(1)',
      proxyMethod: 'GET',
      useProxy: false,
    },
    fakeFetch
  );
  assert.equal(blockedRes.ok, false);
});
