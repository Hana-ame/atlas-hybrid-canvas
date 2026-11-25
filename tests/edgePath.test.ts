import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlPointEdgePath,
  findBestInsertIndex,
  insertControlPoint,
  MAX_EDGE_CONTROL_POINTS,
  removeControlPoint,
  sanitizeControlPoints,
} from '../src/core/edgePath.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

test('buildControlPointEdgePath() renders Bezier without controlPoints and smooth multi-segment spline with controlPoints', () => {
  const plain = buildControlPointEdgePath(0, 0, 200, 100);
  assert.ok(plain.path.startsWith('M 0 0 C '));
  assert.equal(plain.segmentMidpoints.length, 1);

  const routed = buildControlPointEdgePath(1230, 2142, 560, 2105, [
    { x: 1265, y: 2016 },
    { x: 880, y: 2016 },
    { x: 525, y: 2016 },
  ]);
  assert.ok(routed.path.includes('1265.0 2016.0'));
  assert.ok(routed.path.includes('880.0 2016.0'));
  assert.ok(routed.path.includes('525.0 2016.0'));
  assert.equal(routed.segmentMidpoints.length, 4);
  assert.ok(routed.labelY < 2040, 'cancel label should sit in top corridor above nodes');
});

test('insertControlPoint(), removeControlPoint(), findBestInsertIndex(), and sanitizeControlPoints() enforce bounds and caps', () => {
  const pts = [{ x: 100, y: 0 }, { x: 200, y: 0 }];
  const best = findBestInsertIndex({ x: 0, y: 0 }, { x: 300, y: 0 }, pts, { x: 150, y: 5 });
  assert.equal(best, 1);

  const inserted = insertControlPoint(pts, best, { x: 150.4, y: 4.8 });
  assert.deepEqual(inserted, [{ x: 100, y: 0 }, { x: 150, y: 5 }, { x: 200, y: 0 }]);

  const removed = removeControlPoint(inserted, 1);
  assert.deepEqual(removed, pts);

  const noisy = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i }));
  noisy.unshift({ x: Number.NaN, y: 0 });
  const sanitized = sanitizeControlPoints(noisy);
  assert.equal(sanitized.length, MAX_EDGE_CONTROL_POINTS);
});

test('ZONE F seed FSM return edges carry pre-routed controlPoints outside card interiors', () => {
  const seed = createSeedBlueprint();
  for (const id of ['edge-fsm-run-idle', 'edge-fsm-run-pause', 'edge-fsm-pause-run', 'edge-fsm-pause-idle', 'edge-fsm-done-idle']) {
    const edge = seed.edges[id];
    assert.ok(edge, `expected ${id} in seed`);
    assert.ok(Array.isArray(edge.controlPoints) && edge.controlPoints.length >= 2, `${id} should have pre-routed controlPoints`);
  }
});
