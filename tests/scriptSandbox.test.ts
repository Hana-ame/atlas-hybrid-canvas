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
