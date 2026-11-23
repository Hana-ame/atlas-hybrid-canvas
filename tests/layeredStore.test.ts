import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyOverlay, resolveEffectiveNodes } from '../src/core/layeredStore.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

test('resolveEffectiveNodes() lets vars control type, title, color, width, height, and pos/x/y', () => {
  const bp = createSeedBlueprint();
  const overlay = createEmptyOverlay();
  overlay.runtimeVars['node-world-hub'] = {
    type: 'ALERT',
    title: '动态标题',
    color: '#DC2626',
    width: 520,
    height: 310,
    pos: { x: 420, y: 660 },
    locked: true,
  };

  const resolved = resolveEffectiveNodes(bp, overlay)['node-world-hub'];
  assert.equal(resolved.category, 'ALERT');
  assert.equal(resolved.title, '动态标题');
  assert.equal(resolved.color, '#DC2626');
  assert.equal(resolved.width, 520);
  assert.equal(resolved.height, 310);
  assert.equal(resolved.x, 420);
  assert.equal(resolved.y, 660);
  assert.equal(resolved.locked, true);
});

test('resolveEffectiveNodes() supports array pos [x, y] and clamps unsafe width/height', () => {
  const bp = createSeedBlueprint();
  const overlay = createEmptyOverlay();
  overlay.runtimeVars['node-world-hub'] = {
    pos: [123.6, -45.2],
    width: 50,
    height: 99999,
  };
  const resolved = resolveEffectiveNodes(bp, overlay)['node-world-hub'];
  assert.equal(resolved.x, 124);
  assert.equal(resolved.y, -45);
  assert.equal(resolved.width, 180);
  assert.equal(resolved.height, 1200);
});
