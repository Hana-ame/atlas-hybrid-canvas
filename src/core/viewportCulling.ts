/**
 * @file viewportCulling.ts
 * @description 无限画布三环流式加载与裁剪引擎（屏幕外不挂重 DOM/重媒体，同时沿平移方向预加载）：
 * - Ring 0 (mediaActiveBounds): 当前屏幕 + 320px 紧邻预热区，挂载重型媒体（如 PDF iframe）；
 * - Ring 1 (domPreloadBounds): 当前屏幕 + 1 Chunk (512px) + 沿平移方向最多 +512px 前瞻预加载，挂载轻型 React 节点；
 * - Ring 2 (tilePrefetchBounds): 当前屏幕 + 2 Chunk (1024px)，供底层 Canvas 在空闲帧预烘焙离屏瓦片。
 */

import type { AABB, BlueprintEdge } from './types';

export interface ThreeRingBounds {
  /** Ring 0：重型媒体（PDF iframe 等）激活区 */
  mediaActiveBounds: AABB;
  /** Ring 1：交互 DOM 节点预加载区（含方向前瞻） */
  domPreloadBounds: AABB;
  /** Ring 2：离屏 Canvas 瓦片空闲预烘焙区 */
  tilePrefetchBounds: AABB;
}

export function isBoxIntersecting(a: AABB, b: AABB): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * 基于当前视口世界坐标与平移方向向量，计算三环裁剪/预加载包围盒。
 * panDirX / panDirY 取值 -1 | 0 | 1，表示视口中心移动方向。
 */
export function computeThreeRingBounds(
  viewport: AABB,
  chunkSize = 512,
  panDirX = 0,
  panDirY = 0
): ThreeRingBounds {
  const mediaPad = 320;
  const domPad = chunkSize;
  const lookahead = chunkSize;
  const tilePad = chunkSize * 2;

  const extraLeft = panDirX < 0 ? lookahead : 0;
  const extraRight = panDirX > 0 ? lookahead : 0;
  const extraTop = panDirY < 0 ? lookahead : 0;
  const extraBottom = panDirY > 0 ? lookahead : 0;

  return {
    mediaActiveBounds: {
      minX: viewport.minX - mediaPad - Math.round(extraLeft * 0.5),
      minY: viewport.minY - mediaPad - Math.round(extraTop * 0.5),
      maxX: viewport.maxX + mediaPad + Math.round(extraRight * 0.5),
      maxY: viewport.maxY + mediaPad + Math.round(extraBottom * 0.5),
    },
    domPreloadBounds: {
      minX: viewport.minX - domPad - extraLeft,
      minY: viewport.minY - domPad - extraTop,
      maxX: viewport.maxX + domPad + extraRight,
      maxY: viewport.maxY + domPad + extraBottom,
    },
    tilePrefetchBounds: {
      minX: viewport.minX - tilePad - extraLeft,
      minY: viewport.minY - tilePad - extraTop,
      maxX: viewport.maxX + tilePad + extraRight,
      maxY: viewport.maxY + tilePad + extraBottom,
    },
  };
}

/**
 * 视锥连线裁剪：仅保留至少一端已挂载在当前可见/预加载环中的连线，
 * 避免全图数百条远端 SVG 边同时挂载拖慢平移帧率。
 */
export function filterVisibleEdges(
  edges: Record<string, BlueprintEdge>,
  mountedNodeIds: ReadonlySet<string>
): BlueprintEdge[] {
  const out: BlueprintEdge[] = [];
  for (const e of Object.values(edges)) {
    if (mountedNodeIds.has(e.source) || mountedNodeIds.has(e.target)) {
      out.push(e);
    }
  }
  return out;
}
