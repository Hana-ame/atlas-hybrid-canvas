import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';
import { isBoxIntersecting } from '../src/core/viewportCulling.ts';

test('createSeedBlueprint() includes default examples for image, video, slider, pad2d, and image_button controls', () => {
  const bp = createSeedBlueprint();
  const requiredIds = [
    'demo-image-node',
    'demo-video-node',
    'demo-slider-node',
    'demo-pad2d-node',
    'demo-image-button-node',
    'demo-controls-monitor',
  ];
  for (const id of requiredIds) {
    assert.ok(bp.nodes[id], `Missing seed example node: ${id}`);
  }
  assert.ok(bp.nodes['demo-image-node'].script?.includes("type: 'image'"));
  assert.ok(bp.nodes['demo-video-node'].script?.includes("type: 'video'"));
  assert.ok(bp.nodes['demo-slider-node'].script?.includes("type: 'slider'"));
  assert.ok(bp.nodes['demo-pad2d-node'].script?.includes("type: 'pad2d'"));
  assert.ok(bp.nodes['demo-image-button-node'].script?.includes("type: 'image_button'"));
});

test('createSeedBlueprint() has zero overlapping nodes and all edges reference existing nodes', () => {
  const bp = createSeedBlueprint();
  const list = Object.values(bp.nodes);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const overlaps = isBoxIntersecting(
        { minX: a.x, minY: a.y, maxX: a.x + a.width, maxY: a.y + a.height },
        { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height }
      );
      assert.equal(overlaps, false, `Seed nodes ${a.id} and ${b.id} overlap`);
    }
  }
  for (const edge of Object.values(bp.edges)) {
    assert.ok(bp.nodes[edge.source], `Edge ${edge.id} references missing source ${edge.source}`);
    assert.ok(bp.nodes[edge.target], `Edge ${edge.id} references missing target ${edge.target}`);
  }
});
