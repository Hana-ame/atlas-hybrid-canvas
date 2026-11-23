import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBlueprintScripts } from '../src/core/scriptAudit.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

test('auditBlueprintScripts() detects unified scripts, classic script buttons, and proxy_http buttons', () => {
  const bp = createSeedBlueprint();
  const entries = auditBlueprintScripts(bp);
  const keys = new Set(entries.map((e) => e.key));

  // Unified script nodes
  assert.equal(keys.has('example-spawner:__script__'), true);
  assert.equal(keys.has('demo-flow-aggregator:__script__'), true);
  // Classic script button & HTTP proxy button on node-world-hub
  assert.equal(keys.has('node-world-hub:btn-inc'), true);
  assert.equal(keys.has('node-world-hub:btn-proxy'), true);
  // Plain checklist node has no scripts
  assert.equal(entries.some((e) => e.nodeId === 'demo-flow-checklist'), false);
});

test('auditBlueprintScripts() returns empty array for blueprint with only passive text/checklist nodes', () => {
  const bp = createSeedBlueprint();
  bp.nodes = { 'demo-flow-checklist': bp.nodes['demo-flow-checklist'] };
  assert.deepEqual(auditBlueprintScripts(bp), []);
});
