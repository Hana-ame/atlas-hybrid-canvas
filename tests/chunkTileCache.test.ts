import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkTileCache } from '../src/core/chunkTileCache.ts';
import type { ChunkRecord } from '../src/core/chunkManager.ts';

function withMockDocument<T>(fn: () => T): T {
  const prev = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        setTransform() {},
        clearRect() {},
        save() {},
        scale() {},
        translate() {},
        restore() {},
      }),
    }),
  };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = prev;
  }
}

function makeChunk(cx: number, cy: number, version = 1, dirty = false): ChunkRecord {
  return {
    key: `${cx},${cy}`,
    cx,
    cy,
    bounds: { minX: cx * 512, minY: cy * 512, maxX: (cx + 1) * 512, maxY: (cy + 1) * 512 },
    nodeIds: new Set(),
    annotationIds: new Set(),
    dirty,
    version,
    signature: `${cx},${cy}:${version}`,
  };
}

test('ChunkTileCache caches clean tiles and invalidates on version, dirty, lod, or scale change', () => {
  withMockDocument(() => {
    const cache = new ChunkTileCache(4);
    const c = makeChunk(0, 0, 1, false);
    assert.equal(cache.get(c, 'macro', 0.5), null);
    cache.bake(c, 512, 'macro', 0.5, () => {});
    assert.ok(cache.get(c, 'macro', 0.5));
    assert.equal(cache.cacheHits, 1);

    assert.equal(cache.get(makeChunk(0, 0, 2, false), 'macro', 0.5), null);
    assert.equal(cache.get(makeChunk(0, 0, 1, true), 'macro', 0.5), null);
    assert.equal(cache.get(c, 'micro', 0.5), null);
    assert.equal(cache.get(c, 'macro', 1.0), null);
  });
});

test('ChunkTileCache evicts least-recently-used tile and zeroes its canvas dimensions to free GPU memory', () => {
  withMockDocument(() => {
    const cache = new ChunkTileCache(2);
    const c0 = makeChunk(0, 0);
    const c1 = makeChunk(1, 0);
    const c2 = makeChunk(2, 0);

    const t0 = cache.bake(c0, 512, 'macro', 0.5, () => {});
    const t1 = cache.bake(c1, 512, 'macro', 0.5, () => {});
    // Access c0 so c1 becomes the LRU victim
    assert.ok(cache.get(c0, 'macro', 0.5));

    cache.bake(c2, 512, 'macro', 0.5, () => {});
    assert.equal(cache.size, 2);
    assert.ok(cache.get(c0, 'macro', 0.5));
    assert.equal(cache.get(c1, 'macro', 0.5), null);
    assert.equal(t1.canvas.width, 0);
    assert.equal(t1.canvas.height, 0);
    assert.ok(t0.canvas.width > 0);
  });
});

test('ChunkTileCache.clear() zeroes all backing canvases and empties the map', () => {
  withMockDocument(() => {
    const cache = new ChunkTileCache(4);
    const t0 = cache.bake(makeChunk(0, 0), 512, 'macro', 0.5, () => {});
    const t1 = cache.bake(makeChunk(1, 0), 512, 'macro', 0.5, () => {});
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(t0.canvas.width, 0);
    assert.equal(t0.canvas.height, 0);
    assert.equal(t1.canvas.width, 0);
    assert.equal(t1.canvas.height, 0);
  });
});
