import test from 'node:test';
import assert from 'node:assert/strict';
import { computeThreeRingBounds, filterVisibleEdges, isBoxIntersecting } from '../src/core/viewportCulling.ts';
import type { BlueprintEdge } from '../src/core/types.ts';

test('computeThreeRingBounds() expands Ring 0 < Ring 1 < Ring 2 and biases lookahead along pan direction', () => {
  const vp = { minX: 0, minY: 0, maxX: 1280, maxY: 800 };
  const rings = computeThreeRingBounds(vp, 512, 1, 0);

  assert.ok(rings.domPreloadBounds.maxX > rings.mediaActiveBounds.maxX);
  assert.ok(rings.tilePrefetchBounds.maxX > rings.domPreloadBounds.maxX);
  // Panning right (+1) extends right preload margin by an extra chunk compared to left
  const rightMargin = rings.domPreloadBounds.maxX - vp.maxX;
  const leftMargin = vp.minX - rings.domPreloadBounds.minX;
  assert.equal(rightMargin - leftMargin, 512);
});

test('isBoxIntersecting() accurately detects overlap and separation', () => {
  const box = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
  assert.equal(isBoxIntersecting(box, { minX: 400, minY: 400, maxX: 600, maxY: 600 }), true);
  assert.equal(isBoxIntersecting(box, { minX: 501, minY: 0, maxX: 700, maxY: 200 }), false);
});

test('filterVisibleEdges() culls edges when both endpoints are off-screen', () => {
  const edges: Record<string, BlueprintEdge> = {
    e1: { id: 'e1', source: 'n1', target: 'n2', rev: 1, cid: 'c' },
    e2: { id: 'e2', source: 'n2', target: 'n3', rev: 1, cid: 'c' },
    e3: { id: 'e3', source: 'far1', target: 'far2', rev: 1, cid: 'c' },
  };
  const visible = filterVisibleEdges(edges, new Set(['n1']));
  assert.deepEqual(visible.map((e) => e.id), ['e1']);
});
