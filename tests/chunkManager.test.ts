import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/core/chunkManager.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

test('ChunkManager indexes nodes across 512x512 chunks and culls by viewport', () => {
  const cm = new ChunkManager(512);
  const bp = createSeedBlueprint();
  cm.rebuild(bp.nodes, bp.annotations);

  assert.ok(cm.getTotalChunks() >= 3);
  const nearOrigin = cm.queryVisibleChunks({ minX: -100, minY: -100, maxX: 400, maxY: 400 });
  assert.ok(nearOrigin.some((c) => c.cx === 0 && c.cy === 0));

  const farAway = cm.queryVisibleChunks({ minX: 50000, minY: 50000, maxX: 51000, maxY: 51000 });
  assert.equal(farAway.length, 0);
});

test('ChunkManager.rebuild() preserves unchanged chunk versions and only dirties modified chunks', () => {
  const cm = new ChunkManager(512);
  const bp = createSeedBlueprint();
  cm.rebuild(bp.nodes, bp.annotations);

  const originBefore = cm.queryVisibleChunks({ minX: 0, minY: 0, maxX: 100, maxY: 100 })[0];
  const farBefore = cm.queryVisibleChunks({ minX: 1400, minY: 700, maxX: 1450, maxY: 750 })[0];
  cm.markClean(originBefore.key);
  cm.markClean(farBefore.key);

  // Modify only the far PDF node; origin chunk (0,0) must stay clean with same version!
  bp.nodes['demo-pdf-reader'].title = 'Updated PDF Title';
  cm.rebuild(bp.nodes, bp.annotations);

  const originAfter = cm.queryVisibleChunks({ minX: 0, minY: 0, maxX: 100, maxY: 100 })[0];
  const farAfter = cm.queryVisibleChunks({ minX: 1400, minY: 700, maxX: 1450, maxY: 750 })[0];
  assert.equal(originAfter.version, originBefore.version);
  assert.equal(originAfter.dirty, false);
  assert.equal(farAfter.version, farBefore.version + 1);
  assert.equal(farAfter.dirty, true);
});
