/**
 * @file chunkTileCache.ts
 * @description 离屏 Canvas 瓦片 LRU 缓存池（源自 AtlasCanvas）。
 * 将静态背景注释与全景简化色块按固定 LOD 分辨率烘焙为 HTMLCanvasElement 缓存，
 * 使大空间平移缩放降维为 O(visibleChunks) 次 drawImage 贴图。
 */

import type { ChunkRecord } from './chunkManager';
import type { ChunkKey, LODLevel } from './types';

export interface CachedChunkTile {
  key: ChunkKey;
  version: number;
  lod: LODLevel;
  scale: number;
  canvas: HTMLCanvasElement;
  lastUsed: number;
}

/**
 * 离屏 LRU 瓦片缓存（复用自 AtlasCanvas 核心思想）
 * 将每个 512x512 Chunk 的静态背景注释与宏观缩略块烘焙成离屏位图，
 * 缩远鸟瞰时只需 O(visibleChunks) 次 drawImage 贴图。
 */
export class ChunkTileCache {
  private tiles = new Map<ChunkKey, CachedChunkTile>();
  private accessTick = 0;
  readonly maxTiles: number;
  cacheHits = 0;
  cacheMisses = 0;

  constructor(maxTiles = 160) {
    this.maxTiles = maxTiles;
  }

  get(chunk: ChunkRecord, lod: LODLevel, scale: number): CachedChunkTile | null {
    const existing = this.tiles.get(chunk.key);
    if (
      existing &&
      !chunk.dirty &&
      existing.version === chunk.version &&
      existing.lod === lod &&
      Math.abs(existing.scale - scale) < 0.01
    ) {
      this.accessTick++;
      existing.lastUsed = this.accessTick;
      this.cacheHits++;
      return existing;
    }
    this.cacheMisses++;
    return null;
  }

  getFallback(chunk: ChunkRecord): CachedChunkTile | null {
    return this.tiles.get(chunk.key) ?? null;
  }

  bake(
    chunk: ChunkRecord,
    chunkSize: number,
    lod: LODLevel,
    scale: number,
    drawFn: (ctx: CanvasRenderingContext2D) => void
  ): CachedChunkTile {
    const pixelSize = Math.max(64, Math.round(chunkSize * scale));
    let tile = this.tiles.get(chunk.key);
    if (!tile) {
      const canvas = document.createElement('canvas');
      canvas.width = pixelSize;
      canvas.height = pixelSize;
      tile = { key: chunk.key, version: chunk.version, lod, scale, canvas, lastUsed: 0 };
    } else if (tile.canvas.width !== pixelSize || tile.canvas.height !== pixelSize) {
      tile.canvas.width = pixelSize;
      tile.canvas.height = pixelSize;
    }

    const ctx = tile.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pixelSize, pixelSize);
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-chunk.bounds.minX, -chunk.bounds.minY);
      drawFn(ctx);
      ctx.restore();
    }

    this.accessTick++;
    tile.version = chunk.version;
    tile.lod = lod;
    tile.scale = scale;
    tile.lastUsed = this.accessTick;
    this.tiles.set(chunk.key, tile);
    this.evictIfNeeded();
    return tile;
  }

  clear(): void {
    for (const tile of this.tiles.values()) {
      tile.canvas.width = 0;
      tile.canvas.height = 0;
    }
    this.tiles.clear();
  }

  get size(): number {
    return this.tiles.size;
  }

  private evictIfNeeded(): void {
    if (this.tiles.size <= this.maxTiles) return;
    let oldestKey: ChunkKey | null = null;
    let oldestTick = Infinity;
    for (const [k, t] of this.tiles) {
      if (t.lastUsed < oldestTick) {
        oldestTick = t.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const evicted = this.tiles.get(oldestKey);
      if (evicted) {
        evicted.canvas.width = 0;
        evicted.canvas.height = 0;
      }
      this.tiles.delete(oldestKey);
    }
  }
}
