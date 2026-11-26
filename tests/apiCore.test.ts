/**
 * apiCore 是服务端与浏览器共用的唯一业务实现，所以这两边的行为一致性
 * 只需要在这一处验证——不用再为"Express 一份、mock 一份"各写一套断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryStore,
  createWindowRateLimiter,
  handleApiRequest,
  type ApiDeps,
  type ApiRequest,
  type HttpFetcher,
} from '../src/core/apiCore.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeReq(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
): ApiRequest {
  return {
    method,
    path,
    headers: opts.headers ?? {},
    body: opts.body === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(opts.body)),
    clientId: 'test-client',
  };
}

function parse(res: { body: Uint8Array }): any {
  return JSON.parse(dec.decode(res.body));
}

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const defaultFetcher: HttpFetcher = {
    async fetch() {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ hello: 'world' })),
      };
    },
  };
  return {
    store: createMemoryStore(),
    proxy: {
      allowedHosts: ['httpbin.org'],
      hasUpstreamSecret: false,
      saveKey: 'secret-key',
      rateLimitPerMin: 100,
    },
    rateLimiter: createWindowRateLimiter(100),
    fetcher: defaultFetcher,
    mode: 'browser',
    ...overrides,
  };
}

test('apiCore: 未注册的路径返回 null，交由调用方放行', async () => {
  const res = await handleApiRequest(makeDeps(), makeReq('GET', '/api/unknown'));
  assert.equal(res, null);
});

test('apiCore: GET /api/blueprint 初始返回 revision 1 与空蓝图', async () => {
  const res = await handleApiRequest(makeDeps(), makeReq('GET', '/api/blueprint'));
  assert.ok(res);
  assert.equal(res!.status, 200);
  const body = parse(res!);
  assert.equal(body.ok, true);
  assert.equal(body.serverRevision, 1);
  assert.equal(body.blueprint, null);
});

test('apiCore: 方法不匹配返回 405', async () => {
  const res = await handleApiRequest(makeDeps(), makeReq('POST', '/api/blueprint'));
  assert.ok(res);
  assert.equal(res!.status, 405);
});

test('apiCore: publish 密钥错误返回 401，正确则写入并递增 revision', async () => {
  const deps = makeDeps();

  const bad = await handleApiRequest(
    deps,
    makeReq('POST', '/api/blueprint/publish', {
      headers: { 'x-blueprint-save-key': 'wrong' },
      body: { blueprint: { nodes: {} } },
    })
  );
  assert.equal(bad!.status, 401);

  const good = await handleApiRequest(
    deps,
    makeReq('POST', '/api/blueprint/publish', {
      headers: { 'x-blueprint-save-key': 'secret-key' },
      body: { blueprint: { nodes: { n1: { id: 'n1' } } } },
    })
  );
  assert.equal(good!.status, 200);
  assert.equal(parse(good!).serverRevision, 2);

  // 再读一次确认真的落到了 store 里
  const read = await handleApiRequest(deps, makeReq('GET', '/api/blueprint'));
  const bp = parse(read!).blueprint;
  assert.equal(bp.nodes.n1.id, 'n1');
});

test('apiCore: 未配置 saveKey 时 publish 返回 403', async () => {
  const deps = makeDeps();
  deps.proxy.saveKey = '';
  const res = await handleApiRequest(
    deps,
    makeReq('POST', '/api/blueprint/publish', {
      headers: { 'x-blueprint-save-key': 'anything' },
      body: { blueprint: {} },
    })
  );
  assert.equal(res!.status, 403);
});

test('apiCore: 代理目标不在白名单返回 403', async () => {
  const res = await handleApiRequest(
    makeDeps(),
    makeReq('POST', '/api/proxy', { body: { url: 'https://evil.example.com/x' } })
  );
  assert.equal(res!.status, 403);
  assert.match(parse(res!).error, /白名单/);
});

test('apiCore: 代理拒绝非 http/https 协议', async () => {
  const res = await handleApiRequest(
    makeDeps(),
    makeReq('POST', '/api/proxy', { body: { url: 'file:///etc/passwd' } })
  );
  assert.equal(res!.status, 400);
});

test('apiCore: 代理拦截上游 3xx，不跟随重定向', async () => {
  const deps = makeDeps({
    fetcher: {
      async fetch() {
        return { status: 302, headers: { location: 'https://evil.example.com' }, body: new Uint8Array(0) };
      },
    },
  });
  const res = await handleApiRequest(
    deps,
    makeReq('POST', '/api/proxy', { body: { url: 'https://httpbin.org/get', method: 'GET' } })
  );
  assert.equal(res!.status, 502);
  assert.match(parse(res!).error, /3xx/);
});

test('apiCore: 代理成功时解析 JSON 响应并回传状态', async () => {
  const res = await handleApiRequest(
    makeDeps(),
    makeReq('POST', '/api/proxy', { body: { url: 'https://httpbin.org/get', method: 'GET' } })
  );
  assert.equal(res!.status, 200);
  const body = parse(res!);
  assert.equal(body.ok, true);
  assert.equal(body.responseBody.hello, 'world');
});

test('apiCore: 超过限流阈值返回 429 并带 retry-after', async () => {
  const deps = makeDeps({ rateLimiter: createWindowRateLimiter(2) });
  const hit = () =>
    handleApiRequest(deps, makeReq('POST', '/api/proxy', { body: { url: 'https://httpbin.org/get' } }));

  assert.equal((await hit())!.status, 200);
  assert.equal((await hit())!.status, 200);
  const third = await hit();
  assert.equal(third!.status, 429);
  assert.ok(third!.headers['retry-after']);
});

test('apiCore: 超时返回 504', async () => {
  const deps = makeDeps({
    fetcher: {
      fetch() {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), 5));
      },
    },
  });
  const res = await handleApiRequest(
    deps,
    makeReq('POST', '/api/proxy', { body: { url: 'https://httpbin.org/get' } })
  );
  assert.equal(res!.status, 504);
});

test('apiCore: 同一份实现下 browser 与 server 模式返回同构结果', async () => {
  // 这是收敛的核心目的：除了如实标注的 mode 标记，业务字段必须完全一致。
  const browserRes = await handleApiRequest(makeDeps({ mode: 'browser' }), makeReq('GET', '/api/blueprint'));
  const serverRes = await handleApiRequest(makeDeps({ mode: 'server' }), makeReq('GET', '/api/blueprint'));
  const b = parse(browserRes!);
  const s = parse(serverRes!);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(s).sort());
  assert.equal(b.serverRevision, s.serverRevision);
  assert.equal(b.mock, true);
  assert.equal(s.mock, false);
});

test('apiCore: /api/rooms/<roomPath>/blueprint 与 publish 按房间路径隔离读写', async () => {
  const stores = new Map<string, ReturnType<typeof createMemoryStore>>();
  const getRoomStore = (rp: string) => {
    if (!stores.has(rp)) stores.set(rp, createMemoryStore());
    return stores.get(rp)!;
  };
  const deps = makeDeps({ getRoomStore });

  const pub = await handleApiRequest(
    deps,
    makeReq('POST', '/api/rooms/team/design/blueprint/publish', {
      headers: { 'x-blueprint-save-key': 'secret-key' },
      body: { blueprint: { nodes: { n1: { id: 'n1' } } } },
    })
  );
  assert.equal(pub?.status, 200);

  const gotA = await handleApiRequest(deps, makeReq('GET', '/api/rooms/team/design/blueprint'));
  assert.equal(gotA?.status, 200);
  assert.deepEqual(parse(gotA!).blueprint, { nodes: { n1: { id: 'n1' } } });

  const gotB = await handleApiRequest(deps, makeReq('GET', '/api/rooms/team/other/blueprint'));
  assert.equal(gotB?.status, 200);
  assert.equal(parse(gotB!).blueprint, null);
});

test('apiCore: 静态模式兜底 /api/rooms/<room>/history 与 rollback 不穿透 CDN', async () => {
  const deps = makeDeps();
  const h = await handleApiRequest(deps, makeReq('GET', '/api/rooms/team/design/history'));
  assert.equal(h?.status, 200);
  assert.deepEqual(parse(h!).entries, []);

  const rb = await handleApiRequest(deps, makeReq('POST', '/api/rooms/team/design/rollback', { body: { version: 1 } }));
  assert.equal(rb?.status, 403);
});

test('apiCore & proxySecurity: wildcard * allowlist allows public hosts without injecting upstream secrets', async () => {
  const { validateProxyTargetUrl } = await import('../server/proxySecurity.ts');
  const openDeps = makeDeps({
    proxy: {
      allowedHosts: ['*'],
      hasUpstreamSecret: false,
      saveKey: 'secret-key',
      rateLimitPerMin: 30,
    },
  });
  const res = await handleApiRequest(
    openDeps,
    makeReq('POST', '/api/proxy', { body: { url: 'https://any-cors-free.example/data' } })
  );
  assert.equal(res?.status, 200);

  const vPublic = validateProxyTargetUrl('https://any-cors-free.example/data', { allowedHosts: ['*'] });
  assert.equal(vPublic.ok, true);
  if (vPublic.ok) {
    assert.equal(vPublic.injectSecret, false);
  }
  const vLocal = validateProxyTargetUrl('http://127.0.0.1:3000/math/square', { allowedHosts: ['*'] });
  assert.equal(vLocal.ok, false);
});
