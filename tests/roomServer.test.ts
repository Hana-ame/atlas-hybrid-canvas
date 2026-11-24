import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { attachRoomServer } from '../server/roomServer.ts';
import { WebSocket } from 'ws';

/** 起一个临时 HTTP server + 房间服务，返回端口与关闭函数。 */
async function startRoomServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end('ok'));
  const handle = attachRoomServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    close: async () => {
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 带收到的消息队列的连接包装。
 *
 * 为什么需要这个：服务端在 handleUpgrade 回调里同步发出首帧（新成员入房时的全量
 * state 快照）。这一帧往往在客户端 'open' 事件之后、调用方挂上 message 监听之前
 * 就已到达。ws 底层是 EventEmitter —— 没有监听器时事件直接丢弃，不会缓存。于是
 * "connect 完再 waitFor" 的写法会漏掉这一帧，表现为"等待消息超时"。
 *
 * 这里在构造时就挂上唯一的 message 监听，收到的帧进队列；waitFor 从队列里取，
 * 或等下一个符合条件的新帧。测试因此不再依赖 connect 与 waitFor 之间的时序。
 */
class Client {
  readonly ws: WebSocket;
  private queue: any[] = [];
  private waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // 先看有没有正在等的 waiter 能吃掉这一帧
      const idx = this.waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
        return;
      }
      this.queue.push(msg);
    });
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  /** 从已收队列里找，找不到再等新帧。 */
  waitFor(predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const idx = this.queue.findIndex(predicate);
    if (idx >= 0) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error('等待消息超时'));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** 清空已收队列，用于"从现在开始数"的场景。 */
  drain(): void {
    this.queue.length = 0;
  }

  /** 收集一段时间内收到的全部帧，用于断言"某帧不应出现"。 */
  async collect(ms: number): Promise<any[]> {
    await new Promise((r) => setTimeout(r, ms));
    const out = this.queue.slice();
    this.queue.length = 0;
    return out;
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(port: number, room: string, cid: string): Promise<Client> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?room=${encodeURIComponent(room)}&cid=${encodeURIComponent(cid)}`
  );
  // 关键：在等待 open 之前就构造 Client，让 message 监听在连接建立的第一刻到位。
  const client = new Client(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}

test('roomServer: 第二个成员入房时收到第一个成员的全量快照', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'room-a', 'cid-a');
  t.after(() => a.close());

  // A 提交一份状态
  a.send({
    t: 'state',
    blueprint: {
      nodes: { n1: { id: 'n1', rev: 3, cid: 'cid-a', title: '节点一' } },
      annotations: {},
      edges: {},
    },
  });
  await new Promise((r) => setTimeout(r, 80));

  const b = await connect(port, 'room-a', 'cid-b');
  t.after(() => b.close());

  const snapshot = await b.waitFor((m: any) => m.t === 'state');
  assert.equal(snapshot.blueprint.nodes.n1.title, '节点一');
  assert.equal(snapshot.blueprint.nodes.n1.rev, 3);
});

test('roomServer: 增量 upsert 会广播给其他成员，但不回传给发送方', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'afterinc-a', 'cid-a');
  const b = await connect(port, 'afterinc-a', 'cid-b');
  t.after(() => {
    a.close();
    b.close();
  });

  b.drain(); // 清掉入房时的 peer 事件与快照，只关心随后的 upsert
  a.drain();

  a.send({ t: 'upsert_node', node: { id: 'n9', rev: 1, cid: 'cid-a', title: '新节点' } });

  const got = await b.waitFor((m: any) => m.t === 'upsert_node');
  assert.equal(got.node.id, 'n9');
  assert.equal(got.node.title, '新节点');

  // 发送方不应收到自己的 upsert 回显
  const echoed = await a.collect(120);
  assert.equal(
    echoed.some((m) => m.t === 'upsert_node'),
    false,
    '发送方不应收到自己的 upsert 回显'
  );
});

test('roomServer: 同 id 的旧 rev 写入被 LWW 丢弃，不覆盖新版本', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'lww', 'cid-a');
  const b = await connect(port, 'lww', 'cid-b');
  t.after(() => {
    a.close();
    b.close();
  });

  // A 先写 rev=5
  a.send({ t: 'upsert_node', node: { id: 'n1', rev: 5, cid: 'cid-a', title: '新' } });
  await b.waitFor((m: any) => m.t === 'upsert_node' && m.node.rev === 5);
  b.drain();

  // B 再写 rev=2（更旧），应被丢弃
  a.send({ t: 'upsert_node', node: { id: 'n1', rev: 2, cid: 'cid-a', title: '旧' } });
  const after = await b.collect(150);
  assert.equal(
    after.some((m) => m.t === 'upsert_node' && m.node.rev === 2),
    false,
    '过期 rev 不应被广播'
  );
});

test('roomServer: rev 相同时 cid 字典序大的胜出', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'tie', 'cid-zzz');
  const b = await connect(port, 'tie', 'cid-aaa');
  t.after(() => {
    a.close();
    b.close();
  });

  // rev 都是 1，cid-zzz > cid-aaa，所以先写 cid-aaa 的应被后写 cid-zzz 的覆盖
  a.send({ t: 'upsert_node', node: { id: 'n1', rev: 1, cid: 'cid-aaa', title: 'aaa' } });
  await new Promise((r) => setTimeout(r, 60));
  a.send({ t: 'upsert_node', node: { id: 'n1', rev: 1, cid: 'cid-zzz', title: 'zzz' } });
  const got = await b.waitFor((m: any) => m.t === 'upsert_node' && m.node.cid === 'cid-zzz');
  assert.equal(got.node.title, 'zzz');

  // 反过来：cid-aaa 写 rev=1 应被拒（已有 cid-zzz rev=1）
  b.drain();
  a.send({ t: 'upsert_node', node: { id: 'n1', rev: 1, cid: 'cid-aaa', title: 'aaa-again' } });
  const after = await b.collect(150);
  assert.equal(
    after.some((m) => m.t === 'upsert_node' && m.node.cid === 'cid-aaa'),
    false,
    'cid 更小的同 rev 写入应被丢弃'
  );
});

test('roomServer: 非法帧返回 error 且不断开连接', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'bad', 'cid-a');
  t.after(() => a.close());

  a.ws.send('这不是 JSON');
  const err1 = await a.waitFor((m: any) => m.t === 'error');
  assert.match(err1.error, /JSON/);

  // 缺 id 的 upsert
  a.send({ t: 'upsert_node', node: { rev: 1, cid: 'x' } });
  const err2 = await a.waitFor((m: any) => m.t === 'error');
  assert.match(err2.error, /不合法/);

  // 未知类型
  a.send({ t: 'nonsense' });
  const err3 = await a.waitFor((m: any) => m.t === 'error');
  assert.match(err3.error, /未知消息类型/);

  assert.equal(a.readyState, WebSocket.OPEN, '非法帧不应断开连接');
});

test('roomServer: 缺少 room 或 cid 的握手被拒绝', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=only-room`);
        ws.once('open', () => {
          ws.close();
          resolve();
        });
        ws.once('error', (err) => reject(err));
      }),
    '缺少 cid 时应拒绝握手'
  );
});

test('roomServer: 非 /ws 路径的 upgrade 不归房间服务处理', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/other?room=r&cid=c`);
        ws.once('open', () => {
          ws.close();
          resolve();
        });
        ws.once('error', (err) => reject(err));
      }),
    '非 /ws 路径应连不上'
  );
});

test('roomServer: 支持按路径 /ws/<roomPath> 分房间且不同路径状态完全隔离', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws/team/design?cid=cid-a`);
  const a = new Client(wsA);
  await new Promise<void>((resolve, reject) => {
    wsA.once('open', () => resolve());
    wsA.once('error', reject);
  });
  t.after(() => a.close());

  a.send({ t: 'upsert_node', node: { id: 'n-design', rev: 1, cid: 'cid-a', title: 'Design Node' } });
  await new Promise((r) => setTimeout(r, 60));

  const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws/team/other?cid=cid-b`);
  const b = new Client(wsB);
  await new Promise<void>((resolve, reject) => {
    wsB.once('open', () => resolve());
    wsB.once('error', reject);
  });
  t.after(() => b.close());

  const frames = await b.collect(120);
  assert.equal(
    frames.some((m) => m.t === 'state' && m.blueprint?.nodes?.['n-design']),
    false,
    '不同路径房间不应收到 team/design 的节点快照'
  );
});

test('roomServer: 服务端 RoomState.upsert 按 fieldRevs 合并并发非冲突字段', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'field-crdt', 'cid-a');
  const b = await connect(port, 'field-crdt', 'cid-b');
  t.after(() => {
    a.close();
    b.close();
  });

  a.send({
    t: 'upsert_node',
    node: {
      id: 'n1',
      rev: 1,
      cid: 'cid-a',
      title: 'Title-A',
      color: '#111111',
      fieldRevs: {
        title: { rev: 1, cid: 'cid-a' },
        color: { rev: 1, cid: 'cid-a' },
      },
    },
  });
  await b.waitFor((m: any) => m.t === 'upsert_node');

  // cid-a 改 title (rev=2), cid-b 同 rev=2 改 color -> 两者均应保留
  a.send({
    t: 'upsert_node',
    node: {
      id: 'n1',
      rev: 2,
      cid: 'cid-a',
      title: 'Title-A2',
      color: '#111111',
      fieldRevs: {
        title: { rev: 2, cid: 'cid-a' },
        color: { rev: 1, cid: 'cid-a' },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 50));

  b.send({
    t: 'upsert_node',
    node: {
      id: 'n1',
      rev: 2,
      cid: 'cid-b',
      title: 'Title-A',
      color: '#222222',
      fieldRevs: {
        title: { rev: 1, cid: 'cid-a' },
        color: { rev: 2, cid: 'cid-b' },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 60));

  const c = await connect(port, 'field-crdt', 'cid-c');
  t.after(() => c.close());
  const snap = await c.waitFor((m: any) => m.t === 'state');
  assert.equal(snap.blueprint.nodes.n1.title, 'Title-A2');
  assert.equal(snap.blueprint.nodes.n1.color, '#222222');
});

test('roomServer: verifyToken 拒绝无凭证连接并放行 Sec-WebSocket-Protocol 子协议令牌', async (t) => {
  const { extractWsSubprotocolToken } = await import('../server/authSession.ts');
  const server = http.createServer((_req, res) => res.end('ok'));
  const handle = attachRoomServer(server, '/ws', undefined, undefined, (tok) => tok === 'valid-ws-secret');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  t.after(async () => {
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/secure-room?cid=c1`);
        ws.once('open', () => {
          ws.close();
          resolve();
        });
        ws.once('error', reject);
      })
  );

  const b64url = Buffer.from('valid-ws-secret', 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(extractWsSubprotocolToken(`atlas-v1, atlas-auth.${b64url}`), 'valid-ws-secret');

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/secure-room?cid=c2`, [
      'atlas-v1',
      `atlas-auth.${b64url}`,
    ]);
    ws.once('open', () => {
      assert.equal(ws.protocol, 'atlas-v1');
      ws.close();
      resolve();
    });
    ws.once('error', reject);
  });
});

test('roomServer: 支持 WebRTC 信令定向中继 (rtc_offer / rtc_answer / peers)', async (t) => {
  const { port, close } = await startRoomServer();
  t.after(close);

  const a = await connect(port, 'rtc-room', 'cid-a');
  const b = await connect(port, 'rtc-room', 'cid-b');
  t.after(() => {
    a.close();
    b.close();
  });

  const peersMsg = await b.waitFor((m: any) => m.t === 'peers');
  assert.deepEqual(peersMsg.peers, ['cid-a']);

  b.send({ t: 'rtc_offer', to: 'cid-a', sdp: { type: 'offer', sdp: 'mock-sdp' } });
  const offer = await a.waitFor((m: any) => m.t === 'rtc_offer');
  assert.equal(offer.from, 'cid-b');
  assert.equal(offer.sdp.sdp, 'mock-sdp');
});
