import type { AABB, BlueprintNode, CanvasAnnotation, ChunkCoord, ChunkKey } from './types';

export interface ChunkRecord {
  key: ChunkKey;
  cx: number;
  cy: number;
  bounds: AABB;
  nodeIds: Set<string>;
  annotationIds: Set<string>;
  dirty: boolean;
  version: number;
}

export function chunkKey(cx: number, cy: number): ChunkKey {
  return `${cx},${cy}`;
}

export function worldToChunkCoord(x: number, y: number, chunkSize: number): ChunkCoord {
  return {
    cx: Math.floor(x / chunkSize),
    cy: Math.floor(y / chunkSize),
  };
}

export function getChunkBounds(cx: number, cy: number, chunkSize: number): AABB {
  const minX = cx * chunkSize;
  const minY = cy * chunkSize;
  return { minX, minY, maxX: minX + chunkSize, maxY: minY + chunkSize };
}

export function getChunkCoordRange(bounds: AABB, chunkSize: number) {
  return {
    minCx: Math.floor(bounds.minX / chunkSize),
    maxCx: Math.floor(bounds.maxX / chunkSize),
    minCy: Math.floor(bounds.minY / chunkSize),
    maxCy: Math.floor(bounds.maxY / chunkSize),
  };
}

/**
 * 512x512 无限坐标空间哈希分区管理器
 * 画布本身无边界墙，正负方向均可无限延伸
 */
export class ChunkManager {
  readonly chunkSize: number;
  private chunks = new Map<ChunkKey, ChunkRecord>();

  constructor(chunkSize = 512) {
    this.chunkSize = chunkSize;
  }

  private getOrCreate(cx: number, cy: number): ChunkRecord {
    const key = chunkKey(cx, cy);
    let rec = this.chunks.get(key);
    if (!rec) {
      rec = {
        key,
        cx,
        cy,
        bounds: getChunkBounds(cx, cy, this.chunkSize),
        nodeIds: new Set(),
        annotationIds: new Set(),
        dirty: true,
        version: 1,
      };
      this.chunks.set(key, rec);
    }
    return rec;
  }

  rebuild(
    nodes: Record<string, BlueprintNode>,
    annotations: Record<string, CanvasAnnotation>
  ): void {
    const prevVersions = new Map<ChunkKey, number>();
    for (const [k, rec] of this.chunks) {
      prevVersions.set(k, rec.version);
    }
    this.chunks.clear();

    for (const node of Object.values(nodes)) {
      const range = getChunkCoordRange(
        {
          minX: node.x,
          minY: node.y,
          maxX: node.x + node.width,
          maxY: node.y + node.height,
        },
        this.chunkSize
      );
      for (let cy = range.minCy; cy <= range.maxCy; cy++) {
        for (let cx = range.minCx; cx <= range.maxCx; cx++) {
          const rec = this.getOrCreate(cx, cy);
          rec.nodeIds.add(node.id);
          rec.version = (prevVersions.get(rec.key) ?? 0) + 1;
          rec.dirty = true;
        }
      }
    }

    for (const ann of Object.values(annotations)) {
      const estHeight = Math.max(40, ann.height || ann.fontSize * 3);
      const range = getChunkCoordRange(
        {
          minX: ann.x,
          minY: ann.y,
          maxX: ann.x + ann.width,
          maxY: ann.y + estHeight,
        },
        this.chunkSize
      );
      for (let cy = range.minCy; cy <= range.maxCy; cy++) {
        for (let cx = range.minCx; cx <= range.maxCx; cx++) {
          const rec = this.getOrCreate(cx, cy);
          rec.annotationIds.add(ann.id);
          rec.version = (prevVersions.get(rec.key) ?? 0) + 1;
          rec.dirty = true;
        }
      }
    }
  }

  queryVisibleChunks(worldBounds: AABB): ChunkRecord[] {
    const range = getChunkCoordRange(worldBounds, this.chunkSize);
    const out: ChunkRecord[] = [];
    for (let cy = range.minCy; cy <= range.maxCy; cy++) {
      for (let cx = range.minCx; cx <= range.maxCx; cx++) {
        const rec = this.chunks.get(chunkKey(cx, cy));
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  markClean(key: ChunkKey): void {
    const rec = this.chunks.get(key);
    if (rec) rec.dirty = false;
  }

  getTotalChunks(): number {
    return this.chunks.size;
  }
}
