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
