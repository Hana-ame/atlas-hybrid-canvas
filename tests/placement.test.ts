import test from 'node:test';
import assert from 'node:assert/strict';
import { findNonOverlappingPosition, hasAnyOverlap, rectsOverlap, type RectBox } from '../src/core/placement.ts';

test('findNonOverlappingPosition() returns exact desired coordinates when space is free', () => {
  const existing: RectBox[] = [{ x: 0, y: 0, width: 200, height: 120 }];
  const pos = findNonOverlappingPosition({ x: 300, y: 0, width: 200, height: 120 }, existing, { gap: 20 });
  assert.deepEqual(pos, { x: 300, y: 0 });
});

test('findNonOverlappingPosition() shifts a new node clear of an occupied spot without mutating existing boxes', () => {
  const existing: RectBox[] = [{ x: 100, y: 100, width: 300, height: 200 }];
  const desired: RectBox = { x: 100, y: 100, width: 300, height: 200 };
  const pos = findNonOverlappingPosition(desired, existing, { gap: 20 });
  assert.equal(hasAnyOverlap({ x: pos.x, y: pos.y, width: desired.width, height: desired.height }, existing, 20), false);
  // Existing array must remain untouched
  assert.deepEqual(existing[0], { x: 100, y: 100, width: 300, height: 200 });
});

test('findNonOverlappingPosition() handles sequential batch spawning without pairwise overlap', () => {
  const occupied: RectBox[] = [{ x: 0, y: 0, width: 260, height: 160 }];
  for (let i = 0; i < 6; i++) {
    const pos = findNonOverlappingPosition({ x: 0, y: 0, width: 260, height: 160 }, occupied, { gap: 20 });
    const placed: RectBox = { x: pos.x, y: pos.y, width: 260, height: 160 };
    assert.equal(hasAnyOverlap(placed, occupied, 20), false, `Spawn #${i} overlapped existing boxes`);
    occupied.push(placed);
  }
  // Verify all 7 boxes are pairwise non-overlapping
  for (let i = 0; i < occupied.length; i++) {
    for (let j = i + 1; j < occupied.length; j++) {
      assert.equal(rectsOverlap(occupied[i], occupied[j], 20), false);
    }
  }
});
