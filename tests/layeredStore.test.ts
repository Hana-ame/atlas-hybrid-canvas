import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlayToBase, clearConflictingRuntimeVars, createEmptyOverlay, resolveEffectiveAnnotations, resolveEffectiveNodes, sanitizeEphemeralBlobVars } from '../src/core/layeredStore.ts';
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

test('clearConflictingRuntimeVars() drops pos/x/y on manual drag without erasing unrelated vars', () => {
  const rt = { pos: { x: 1040, y: 1005 }, x: 1040, score: 50, modeIdx: 1 };
  const cleaned = clearConflictingRuntimeVars(rt, { x: 600, y: 700 });
  assert.deepEqual(cleaned, { score: 50, modeIdx: 1 });
});

test('manual drag/resize/title patch wins over previous script vars once conflicting runtimeVars are cleared', () => {
  const bp = createSeedBlueprint();
  const overlay = createEmptyOverlay();
  overlay.runtimeVars['node-world-hub'] = { pos: { x: 999, y: 888 }, width: 520, title: '脚本标题', score: 9 };

  const manualPatch = { x: 320, y: 410, width: 300, title: '手动标题' };
  overlay.runtimeVars['node-world-hub'] = clearConflictingRuntimeVars(overlay.runtimeVars['node-world-hub'], manualPatch)!;
  overlay.nodePatches['node-world-hub'] = manualPatch;

  const resolved = resolveEffectiveNodes(bp, overlay)['node-world-hub'];
  assert.equal(resolved.x, 320);
  assert.equal(resolved.y, 410);
  assert.equal(resolved.width, 300);
  assert.equal(resolved.title, '手动标题');
  assert.equal(resolved.effectiveVars.score, 9);
});

test('resolveEffectiveNodes() lets explicit vars.x/y override vars.pos when both are present', () => {
  const bp = createSeedBlueprint();
  const overlay = createEmptyOverlay();
  overlay.runtimeVars['node-world-hub'] = { pos: { x: 100, y: 200 }, x: 555 };
  const resolved = resolveEffectiveNodes(bp, overlay)['node-world-hub'];
  assert.equal(resolved.x, 555);
  assert.equal(resolved.y, 200);
});

test('resolveEffectiveAnnotations() merges script annotationOverrides onto base annotations', () => {
  const bp = createSeedBlueprint();
  const overlay = createEmptyOverlay();
  overlay.annotationOverrides['ann-zone-0'] = { bgColor: '#FCE7F3', bgOpacity: 0.9, text: '动态区域' };
  const anns = resolveEffectiveAnnotations(bp, overlay);
  assert.equal(anns['ann-zone-0'].bgColor, '#FCE7F3');
  assert.equal(anns['ann-zone-0'].text, '动态区域');
});

test('applyOverlayToBase() commits patches, increments rev, and ignores orphan nodeIds', () => {
  const bp = createSeedBlueprint();
  const prevRev = bp.nodes['node-world-hub'].rev;
  const overlay = createEmptyOverlay();
  overlay.nodePatches['node-world-hub'] = { title: 'Published Title' };
  overlay.nodePatches['deleted-orphan'] = { title: 'Should Be Ignored' };

  const published = applyOverlayToBase(bp, overlay, 'publisher-cid');
  assert.equal(published.nodes['node-world-hub'].title, 'Published Title');
  assert.equal(published.nodes['node-world-hub'].rev, prevRev + 1);
  assert.equal(published.nodes['node-world-hub'].cid, 'publisher-cid');
  assert.equal(published.nodes['deleted-orphan'], undefined);
});

test('sanitizeEphemeralBlobVars() strips stale blob: pdfUrl across page reloads while preserving https/server URLs', () => {
  const cleaned = sanitizeEphemeralBlobVars({
    a: { pdfUrl: 'blob:https://example.com/dead-id', pdfTotalPages: 3, pdfPage: 2 },
    b: { pdfUrl: '/api/pdf/abc123', pdfTotalPages: 12, pdfPage: 4 },
    c: { pdfUrl: 'https://example.com/paper.pdf', pdfTotalPages: 8 },
  });
  assert.equal(cleaned.a.pdfUrl, '');
  assert.equal(cleaned.a.pdfTotalPages, 0);
  assert.equal(cleaned.b.pdfUrl, '/api/pdf/abc123');
  assert.equal(cleaned.c.pdfUrl, 'https://example.com/paper.pdf');
});
