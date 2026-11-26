import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areControlPointsEqual,
  buildControlPointEdgePath,
  computeControlPointBezierSegments,
  createControlPointDragSession,
  decideEdgeDoubleClickAction,
  evalCubicBezier,
  resolveNodePortY,
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

test('computeControlPointBezierSegments() & areControlPointsEqual() keep macro Canvas and SVG routing identical', () => {
  const segs = computeControlPointBezierSegments(100, 100, 500, 100, [{ x: 250, y: 20 }, { x: 350, y: 20 }]);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].x0, 100);
  assert.equal(segs[2].x, 500);

  assert.equal(areControlPointsEqual(undefined, []), true);
  assert.equal(areControlPointsEqual([{ x: 10, y: 20 }], [{ x: 10.2, y: 19.8 }]), true);
  assert.equal(areControlPointsEqual([{ x: 10, y: 20 }], [{ x: 11, y: 20 }]), false);
});

test('createControlPointDragSession() blocks right-click resurrection, ignores 2px jitter, rolls back pointercancel, filters pointerId, and cleans up on unmount', () => {
  type ListenerMap = Record<string, Set<(ev: any) => void>>;
  const makeHarness = () => {
    const listeners: ListenerMap = { pointermove: new Set(), pointerup: new Set(), pointercancel: new Set() };
    const drafts: Array<any> = [];
    const commits: Array<any> = [];
    const emit = (type: string, ev: any) => {
      for (const fn of Array.from(listeners[type])) fn(ev);
    };
    const listenerCount = () =>
      listeners.pointermove.size + listeners.pointerup.size + listeners.pointercancel.size;
    return {
      listeners,
      drafts,
      commits,
      emit,
      listenerCount,
      addWindowListener: (type: string, fn: any) => listeners[type].add(fn),
      removeWindowListener: (type: string, fn: any) => listeners[type].delete(fn),
    };
  };

  const h1 = makeHarness();
  const s1 = createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 100, y: 100 }],
    isNewInsert: false,
    startEvent: { button: 2, pointerId: 1, clientX: 100, clientY: 100 },
    screenToFlow: (p) => p,
    onDraftChange: (d) => h1.drafts.push(d),
    onCommit: (pts) => h1.commits.push(pts),
    addWindowListener: h1.addWindowListener as any,
    removeWindowListener: h1.removeWindowListener as any,
  });
  assert.equal(s1, null);
  assert.equal(h1.listenerCount(), 0);

  const h2 = makeHarness();
  const s2 = createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 100, y: 100 }],
    isNewInsert: false,
    startEvent: { button: 0, pointerId: 1, clientX: 100, clientY: 100 },
    screenToFlow: (p) => p,
    onDraftChange: (d) => h2.drafts.push(d),
    onCommit: (pts) => h2.commits.push(pts),
    addWindowListener: h2.addWindowListener as any,
    removeWindowListener: h2.removeWindowListener as any,
  });
  assert.ok(s2);
  h2.emit('pointermove', { pointerId: 1, clientX: 102, clientY: 101 });
  h2.emit('pointerup', { pointerId: 1, clientX: 102, clientY: 101 });
  assert.equal(h2.commits.length, 0, '2px jitter must not trigger undo/CRDT commit');
  assert.equal(h2.listenerCount(), 0);

  const h3 = makeHarness();
  createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 150, y: 150 }],
    isNewInsert: true,
    startEvent: { button: 0, pointerId: 7, clientX: 150, clientY: 150 },
    screenToFlow: (p) => p,
    onDraftChange: (d) => h3.drafts.push(d),
    onCommit: (pts) => h3.commits.push(pts),
    addWindowListener: h3.addWindowListener as any,
    removeWindowListener: h3.removeWindowListener as any,
  });
  h3.emit('pointerup', { pointerId: 99, clientX: 200, clientY: 200 });
  assert.equal(h3.commits.length, 0);
  assert.equal(h3.listenerCount(), 3);
  h3.emit('pointercancel', { pointerId: 7, clientX: 160, clientY: 160 });
  assert.equal(h3.commits.length, 0, 'pointercancel must never commit');
  assert.equal(h3.drafts[h3.drafts.length - 1], null);
  assert.equal(h3.listenerCount(), 0);

  const h4 = makeHarness();
  const cleanup4 = createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 100, y: 100 }],
    isNewInsert: false,
    startEvent: { button: 0, pointerId: 1, clientX: 100, clientY: 100 },
    screenToFlow: (p) => p,
    onDraftChange: (d) => h4.drafts.push(d),
    onCommit: (pts) => h4.commits.push(pts),
    addWindowListener: h4.addWindowListener as any,
    removeWindowListener: h4.removeWindowListener as any,
  });
  h4.emit('pointermove', { pointerId: 1, clientX: 140, clientY: 130 });
  assert.equal(h4.listenerCount(), 3);
  cleanup4!();
  assert.equal(h4.listenerCount(), 0, 'unmount cleanup must remove all window listeners');
  h4.emit('pointerup', { pointerId: 1, clientX: 140, clientY: 130 });
  assert.equal(h4.commits.length, 0);

  const h5 = makeHarness();
  createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 100, y: 100 }],
    isNewInsert: false,
    startEvent: { button: 0, pointerId: 3, clientX: 100, clientY: 100 },
    screenToFlow: (p) => p,
    onDraftChange: (d) => h5.drafts.push(d),
    onCommit: (pts) => h5.commits.push(pts),
    addWindowListener: h5.addWindowListener as any,
    removeWindowListener: h5.removeWindowListener as any,
  });
  h5.emit('pointermove', { pointerId: 3, clientX: 150, clientY: 120 });
  h5.emit('pointerup', { pointerId: 3, clientX: 150, clientY: 120 });
  assert.deepEqual(h5.commits, [[{ x: 150, y: 120 }]]);

  const h6 = makeHarness();
  const s6 = createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 100, y: 100 }],
    isNewInsert: false,
    startEvent: { button: 0, pointerId: 1, clientX: 100, clientY: 100 },
    screenToFlow: (p) => p,
    onDraftChange: (d) => h6.drafts.push(d),
    onCommit: undefined,
    addWindowListener: h6.addWindowListener as any,
    removeWindowListener: h6.removeWindowListener as any,
  });
  assert.equal(s6, null);
  assert.equal(h6.listenerCount(), 0);
});

test('resolveNodePortY() aligns macro multi-port Y with WidgetNode and ZONE F cancel corridor clears banner & cards', () => {
  const seed = createSeedBlueprint();
  const idle = seed.nodes['fsm-idle'];
  const yIn1 = resolveNodePortY(idle, 'in-1', 'input');
  const yIn2 = resolveNodePortY(idle, 'in-2', 'input');
  assert.equal(yIn1, idle.y + idle.height * (1 / 3));
  assert.equal(yIn2, idle.y + idle.height * (2 / 3));

  const banner = seed.annotations['ann-zone-fsm'];
  const cancelEdge = seed.edges['edge-fsm-run-idle'];
  const bannerBottom = banner.y + banner.height;
  for (const cp of cancelEdge.controlPoints || []) {
    assert.ok(cp.y > bannerBottom, `cancel cp.y (${cp.y}) must sit below banner bottom (${bannerBottom})`);
    assert.ok(cp.y < idle.y, `cancel cp.y (${cp.y}) must sit above card top (${idle.y})`);
  }

  const segs = computeControlPointBezierSegments(0, 0, 200, 0, [{ x: 100, y: -120 }]);
  const b05 = evalCubicBezier(segs[0], 0.5);
  const pathInfo = buildControlPointEdgePath(0, 0, 200, 0, [{ x: 100, y: -120 }]);
  assert.equal(pathInfo.segmentMidpoints[0].x, Math.round(b05.x));
  assert.equal(pathInfo.segmentMidpoints[0].y, Math.round(b05.y));
});

test('resolveNodePortY() falls back to DEFAULT_INPUT_PORTS when node.inputPorts is undefined', () => {
  const seed = createSeedBlueprint();
  const lore = seed.nodes['node-lore-north'];
  assert.equal(lore.inputPorts, undefined, 'seed node-lore-north uses implicit default ports');
  assert.equal(resolveNodePortY(lore, 'in-1', 'input'), lore.y + lore.height * (1 / 3));
  assert.equal(resolveNodePortY(lore, 'in-2', 'input'), lore.y + lore.height * (2 / 3));
  assert.equal(resolveNodePortY(lore, 'out-1', 'output'), lore.y + lore.height * 0.5);
});

test('decideEdgeDoubleClickAction() preserves normal & Shift double-click for label edit, reserves Alt+double-click for control point insert', () => {
  assert.equal(decideEdgeDoubleClickAction({ altKey: false, hasOnUpdate: true }), 'bubble_edit_label');
  assert.equal(decideEdgeDoubleClickAction({ altKey: true, hasOnUpdate: true }), 'insert_control_point');
  assert.equal(decideEdgeDoubleClickAction({ altKey: true, hasOnUpdate: false }), 'bubble_edit_label');
});

test('createControlPointDragSession() guards out-of-bounds index and non-finite screenToFlow coordinates', () => {
  let commits = 0;
  const noop = () => {};
  const badIdx = createControlPointDragSession({
    index: 5,
    initialPoints: [{ x: 10, y: 10 }],
    isNewInsert: false,
    startEvent: { button: 0, pointerId: 1, clientX: 10, clientY: 10 },
    screenToFlow: (p) => p,
    onDraftChange: noop,
    onCommit: () => { commits += 1; },
    addWindowListener: noop,
    removeWindowListener: noop,
  });
  assert.equal(badIdx, null);

  const listeners: Record<string, Set<(ev: any) => void>> = { pointermove: new Set(), pointerup: new Set(), pointercancel: new Set() };
  createControlPointDragSession({
    index: 0,
    initialPoints: [{ x: 10, y: 10 }],
    isNewInsert: false,
    startEvent: { button: 0, pointerId: 1, clientX: 10, clientY: 10 },
    screenToFlow: () => ({ x: Number.NaN, y: Number.POSITIVE_INFINITY }),
    onDraftChange: noop,
    onCommit: () => { commits += 1; },
    addWindowListener: (t, fn) => listeners[t].add(fn),
    removeWindowListener: (t, fn) => listeners[t].delete(fn),
  });
  for (const fn of Array.from(listeners.pointermove)) fn({ pointerId: 1, clientX: 100, clientY: 100 });
  for (const fn of Array.from(listeners.pointerup)) fn({ pointerId: 1, clientX: 100, clientY: 100 });
  assert.equal(commits, 0, 'non-finite flow coordinates must be ignored without committing');
});

test('insertControlPoint() rejects non-finite points and resolveNodePortY() aligns omitted handleId with first port', () => {
  const base = [{ x: 10, y: 20 }];
  assert.deepEqual(insertControlPoint(base, 0, { x: Number.NaN, y: 30 }), base);
  assert.deepEqual(insertControlPoint(base, 0, { x: 10, y: Number.POSITIVE_INFINITY }), base);

  const seed = createSeedBlueprint();
  const lore = seed.nodes['node-lore-north'];
  // Omitted targetHandle on a 2-port node matches React Flow's first port (1/3)
  assert.equal(resolveNodePortY(lore, undefined, 'input'), lore.y + lore.height * (1 / 3));
});
