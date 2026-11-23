/**
 * @file chunkManager.ts
 * @description 512×512 无限坐标空间哈希分区索引器（源自 AtlasCanvas）。
 * 支持正负无限世界坐标映射到整数 Chunk 坐标 (cx, cy)、跨分区实体追踪、视锥可见分区查询，
 * 以及分块级内容签名比对（仅脏区块递增 version，未变更区块 100% 保留离屏瓦片缓存）。
 */

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
  signature: string;
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
        signature: '',
      };
      this.chunks.set(key, rec);
    }
    return rec;
  }

  rebuild(
    nodes: Record<string, BlueprintNode>,
    annotations: Record<string, CanvasAnnotation>
  ): void {
    const prevMeta = new Map<ChunkKey, { version: number; signature: string; dirty: boolean }>();
    for (const [k, rec] of this.chunks) {
      prevMeta.set(k, { version: rec.version, signature: rec.signature, dirty: rec.dirty });
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
        }
      }
    }

    // 逐块计算轻量签名：只有内容真正发生变化的区块才标脏并递增 version。
    // 签名必须覆盖「瓦片会画出来的全部字段」，漏一个就会留下过期瓦片：
    // 节点画出的是 title（正文 body 不画，但保守起见仍计入，避免将来改了绘制逻辑就失配）；
    // annotation 画出的是 text 首行与 color/bg/fontSize/imageUrl。
    for (const rec of this.chunks.values()) {
      const parts: string[] = [];
      const sortedNodes = Array.from(rec.nodeIds).sort();
      for (const nid of sortedNodes) {
        const n = nodes[nid];
        if (n) {
          parts.push(
            `N:${n.id}:${n.x},${n.y},${n.width},${n.height},${n.color},${n.title},${n.body.length},${n.category ?? ''},${n.locked ? 1 : 0}`
          );
        }
      }
      const sortedAnns = Array.from(rec.annotationIds).sort();
      for (const aid of sortedAnns) {
        const a = annotations[aid];
        if (a) {
          // 只取 text 前 32 字符会在「第 33 字符之后被改」时漏判脏；
          // 补上总长度与末段字符，用小代价覆盖尾部修改。
          const text = a.text ?? '';
          parts.push(
            `A:${a.id}:${a.x},${a.y},${a.width},${a.height},${a.color},${a.bgColor ?? ''},${a.bgOpacity ?? ''},${a.fontSize},${text.length}:${text.slice(0, 32)}:${text.slice(-16)}:${a.imageUrl ? a.imageUrl.length : 0}`
          );
        }
      }
      const sig = parts.join('|');
      rec.signature = sig;
      const prev = prevMeta.get(rec.key);
      if (prev && prev.signature === sig) {
        rec.version = prev.version;
        rec.dirty = prev.dirty;
      } else {
        rec.version = (prev?.version ?? 0) + 1;
        rec.dirty = true;
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
