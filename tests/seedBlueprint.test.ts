import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';
import { BUILTIN_TEMPLATES } from '../src/core/widgetTemplates.ts';
import { isBoxIntersecting } from '../src/core/viewportCulling.ts';
import { buildControlPointEdgePath, computeControlPointBezierSegments, evalCubicBezier, resolveNodePortY } from '../src/core/edgePath.ts';

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

test('createSeedBlueprint() includes interactive 4-state FSM example (ZONE F) with valid cyclic transitions', () => {
  const bp = createSeedBlueprint();
  const fsmNodes = ['fsm-idle', 'fsm-running', 'fsm-paused', 'fsm-done', 'fsm-monitor'];
  for (const id of fsmNodes) {
    assert.ok(bp.nodes[id], `Missing FSM node: ${id}`);
  }
  assert.equal(bp.nodes['fsm-idle'].defaultVars.active, true);
  assert.equal(bp.nodes['fsm-running'].defaultVars.active, false);
  assert.equal(bp.nodes['fsm-paused'].defaultVars.active, false);
  assert.equal(bp.nodes['fsm-done'].defaultVars.active, false);

  const fsmEdges = [
    'edge-fsm-idle-run',
    'edge-fsm-run-idle',
    'edge-fsm-run-pause',
    'edge-fsm-pause-run',
    'edge-fsm-pause-idle',
    'edge-fsm-run-done',
    'edge-fsm-done-idle',
  ];
  for (const eid of fsmEdges) {
    assert.ok(bp.edges[eid], `Missing FSM transition edge: ${eid}`);
  }
});

test('ZONE F FSM edges have zero node occlusion and well-separated labels', () => {
  const bp = createSeedBlueprint();
  const fsmNodeIds = ['fsm-idle', 'fsm-running', 'fsm-paused', 'fsm-done', 'fsm-monitor'];
  const fsmEdgeIds = [
    'edge-fsm-idle-run',
    'edge-fsm-run-idle',
    'edge-fsm-run-pause',
    'edge-fsm-pause-run',
    'edge-fsm-pause-idle',
    'edge-fsm-run-done',
    'edge-fsm-done-idle',
  ];
  const boxes = fsmNodeIds.map((id) => ({ id, ...bp.nodes[id] }));
  const labels: Array<{ id: string; x: number; y: number }> = [];

  for (const eid of fsmEdgeIds) {
    const edge = bp.edges[eid];
    const src = bp.nodes[edge.source];
    const dst = bp.nodes[edge.target];
    const sx = src.x + src.width;
    const sy = resolveNodePortY(src, edge.sourceHandle, 'output');
    const tx = dst.x;
    const ty = resolveNodePortY(dst, edge.targetHandle, 'input');

    const segs = computeControlPointBezierSegments(sx, sy, tx, ty, edge.controlPoints);
    for (let si = 0; si < segs.length; si++) {
      for (let k = 1; k < 24; k++) {
        const t = k / 24;
        const pt = evalCubicBezier(segs[si], t);
        for (const box of boxes) {
          if ((si === 0 && t < 0.15 && box.id === edge.source) || (si === segs.length - 1 && t > 0.85 && box.id === edge.target)) {
            continue;
          }
          const inside =
            pt.x > box.x + 2 && pt.x < box.x + box.width - 2 &&
            pt.y > box.y + 2 && pt.y < box.y + box.height - 2;
          assert.equal(inside, false, `FSM edge ${eid} occludes node ${box.id} at (${Math.round(pt.x)}, ${Math.round(pt.y)})`);
        }
      }
    }

    const built = buildControlPointEdgePath(sx, sy, tx, ty, edge.controlPoints);
    labels.push({ id: eid, x: built.labelX, y: built.labelY });
  }

  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const dist = Math.hypot(labels[i].x - labels[j].x, labels[i].y - labels[j].y);
      assert.ok(dist >= 36, `FSM edge labels ${labels[i].id} and ${labels[j].id} too close: ${dist.toFixed(1)}px`);
    }
  }
});

test('createSeedBlueprint() and BUILTIN_TEMPLATES cover all ZONE H e.g. widgets', () => {
  const bp = createSeedBlueprint();
  const zoneHIds = [
    'eg-all-in-one',
    'eg-markdown-buttons',
    'eg-reactive-onchange',
    'eg-edge-channel',
    'eg-api-poller',
    'eg-elyfn-runner',
    'eg-git-gateway',
    'eg-pi-agent',
  ];
  for (const id of zoneHIds) {
    assert.ok(bp.nodes[id], `Missing ZONE H e.g. node: ${id}`);
  }
  assert.ok(bp.annotations['ann-zone-examples'], 'Missing ZONE H annotation');
  assert.ok(bp.edges['edge-eg-elyfn-pi'], 'Missing ZONE H elyfn->pi edge');

  for (const tplId of ['tpl-usage-cheatsheet', 'tpl-reactive-onchange', 'tpl-edge-channel-demo']) {
    assert.ok(BUILTIN_TEMPLATES.some((t) => t.id === tplId), `Missing template: ${tplId}`);
  }
});
