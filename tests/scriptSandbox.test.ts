import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
    if (tpl.preset?.script) {
      assert.equal(validateScriptSafety(tpl.preset.script).ok, true, `Template script safety failed: ${tpl.id}`);
      const syn = validateScriptSyntax(tpl.preset.script);
      assert.equal(syn.ok, true, `Template script syntax failed (${tpl.id}): ${syn.error}`);
    }
  }
});
