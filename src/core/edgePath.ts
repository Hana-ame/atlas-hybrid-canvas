/**
 * @file edgePath.ts
 * @description 可控连线（带控制点）的纯几何路径与标签定位工具：
 * - 无控制点时生成平滑三次贝塞尔曲线；
 * - 有控制点时使用 Catmull-Rom 转三次贝塞尔样条，平滑穿过全部控制点；
 * - 计算连线视觉中点用于标签定位，以及点击线段插入控制点的最优索引。
 */

import type { EdgeControlPoint } from './types';

export const MAX_EDGE_CONTROL_POINTS = 12;

export function sanitizeControlPoints(raw: unknown): EdgeControlPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: EdgeControlPoint[] = [];
  for (const item of raw) {
    if (out.length >= MAX_EDGE_CONTROL_POINTS) break;
    if (!item || typeof item !== 'object') continue;
    const x = Number((item as { x?: unknown }).x);
    const y = Number((item as { y?: unknown }).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/**
 * 给定起点、终点与若干控制点，生成平滑穿过所有控制点的 SVG path 与标签中点坐标。
 * 使用 Centripetal/Uniform Catmull-Rom 转为三次贝塞尔段（张力 0.5），既平滑又贴合控制点。
 */
export function buildControlPointEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  controlPoints?: EdgeControlPoint[]
): { path: string; labelX: number; labelY: number; segmentMidpoints: Array<{ x: number; y: number; insertIndex: number }> } {
  const cps = sanitizeControlPoints(controlPoints);
  if (cps.length === 0) {
    const dx = Math.max(48, Math.abs(targetX - sourceX) * 0.45);
    const c1x = sourceX + dx;
    const c1y = sourceY;
    const c2x = targetX - dx;
    const c2y = targetY;
    const path = `M ${sourceX} ${sourceY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetX} ${targetY}`;
    const labelX = 0.125 * sourceX + 0.375 * c1x + 0.375 * c2x + 0.125 * targetX;
    const labelY = 0.125 * sourceY + 0.375 * c1y + 0.375 * c2y + 0.125 * targetY;
    return {
      path,
      labelX: Math.round(labelX),
      labelY: Math.round(labelY),
      segmentMidpoints: [{ x: Math.round(labelX), y: Math.round(labelY), insertIndex: 0 }],
    };
  }

  const pts: EdgeControlPoint[] = [
    { x: sourceX, y: sourceY },
    ...cps,
    { x: targetX, y: targetY },
  ];

  // Catmull-Rom 样条转三次贝塞尔段
  const parts: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    parts.push(
      `C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
    );
  }

  // 计算每段中点（供悬停/选中时显示 "+" 插入控制点手柄）
  const segmentMidpoints: Array<{ x: number; y: number; insertIndex: number }> = [];
  const segLengths: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segLengths.push(len);
    totalLen += len;
    segmentMidpoints.push({
      x: Math.round((a.x + b.x) / 2),
      y: Math.round((a.y + b.y) / 2),
      insertIndex: i,
    });
  }

  // 标签放在整条折线弧长 50% 处，避免挤到端点或互相重叠
  let labelX = pts[Math.floor(pts.length / 2)].x;
  let labelY = pts[Math.floor(pts.length / 2)].y;
  if (totalLen > 0) {
    let acc = 0;
    const half = totalLen / 2;
    for (let i = 0; i < segLengths.length; i++) {
      if (acc + segLengths[i] >= half && segLengths[i] > 0) {
        const t = (half - acc) / segLengths[i];
        labelX = pts[i].x + (pts[i + 1].x - pts[i].x) * t;
        labelY = pts[i].y + (pts[i + 1].y - pts[i].y) * t;
        break;
      }
      acc += segLengths[i];
    }
  }

  return {
    path: parts.join(' '),
    labelX: Math.round(labelX),
    labelY: Math.round(labelY),
    segmentMidpoints,
  };
}

/** 计算点到线段的最短距离平方，用于双击连线任意位置时找到最合适的插入段索引。 */
function distSqToSegment(p: EdgeControlPoint, a: EdgeControlPoint, b: EdgeControlPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 0.0001) return wx * wx + wy * wy;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const projX = a.x + t * vx;
  const projY = a.y + t * vy;
  return (p.x - projX) ** 2 + (p.y - projY) ** 2;
}

export function findBestInsertIndex(
  source: EdgeControlPoint,
  target: EdgeControlPoint,
  controlPoints: EdgeControlPoint[],
  clickPoint: EdgeControlPoint
): number {
  const pts = [source, ...controlPoints, target];
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distSqToSegment(clickPoint, pts[i], pts[i + 1]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function insertControlPoint(
  controlPoints: EdgeControlPoint[],
  index: number,
  point: EdgeControlPoint
): EdgeControlPoint[] {
  const safe = sanitizeControlPoints(controlPoints);
  if (safe.length >= MAX_EDGE_CONTROL_POINTS) return safe;
  const idx = Math.max(0, Math.min(safe.length, index));
  const next = safe.slice();
  next.splice(idx, 0, { x: Math.round(point.x), y: Math.round(point.y) });
  return next;
}

export function removeControlPoint(controlPoints: EdgeControlPoint[], index: number): EdgeControlPoint[] {
  const safe = sanitizeControlPoints(controlPoints);
  if (index < 0 || index >= safe.length) return safe;
  return safe.filter((_, i) => i !== index);
}
