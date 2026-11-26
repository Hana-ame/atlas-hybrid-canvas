/**
 * @file edgePath.ts
 * @description 可控连线（带控制点）的纯几何路径、端口定位与交互拖拽状态机：
 * - 无控制点时生成平滑三次贝塞尔曲线；
 * - 有控制点时使用 Centripetal Catmull-Rom（α = 0.5）转三次贝塞尔样条，平滑穿过全部控制点并收敛疏密不均时的过冲；
 * - segmentMidpoints 与 labelX/labelY 均按真实三次贝塞尔曲线 B(t) 采样，贴合曲线本体；
 * - 提供 resolveNodePortY() 与 WidgetNode 多端口纵坐标公式 100% 同源，供全景 Canvas 复用；
 * - 提供纯状态机 createControlPointDragSession()，统一处理左键过滤、4px 抖动阈值、pointerId 隔离、pointercancel 回滚与卸载清理。
 */

import type { EdgeControlPoint, NodePortSpec } from './types';

export const MAX_EDGE_CONTROL_POINTS = 12;
export const CONTROL_POINT_DRAG_THRESHOLD_PX = 4;

export const DEFAULT_INPUT_PORTS: NodePortSpec[] = [
  { id: 'in-1', label: '入口 1' },
  { id: 'in-2', label: '入口 2' },
];

export const DEFAULT_OUTPUT_PORTS: NodePortSpec[] = [
  { id: 'out-1', label: '出口 1' },
];

/** 决定连线本体双击行为：仅 Alt+双击且可写时插入控制点，普通双击与 Shift+双击一律放行冒泡给标签编辑。 */
export function decideEdgeDoubleClickAction(opts: {
  altKey?: boolean;
  hasOnUpdate: boolean;
}): 'insert_control_point' | 'bubble_edit_label' {
  return opts.hasOnUpdate && Boolean(opts.altKey) ? 'insert_control_point' : 'bubble_edit_label';
}

export interface CubicBezierSegment {
  x0: number;
  y0: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
}

export function sanitizeControlPoints(raw: unknown): EdgeControlPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: EdgeControlPoint[] = [];
  for (const item of raw) {
    if (out.length >= MAX_EDGE_CONTROL_POINTS) break;
    if (!item || typeof item !== 'object') continue;
    const rawX = (item as { x?: unknown }).x;
    const rawY = (item as { y?: unknown }).y;
    if (typeof rawX !== 'number' || typeof rawY !== 'number') continue;
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
    const x = rawX;
    const y = rawY;
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

export function areControlPointsEqual(
  a?: EdgeControlPoint[] | null,
  b?: EdgeControlPoint[] | null
): boolean {
  const sa = sanitizeControlPoints(a);
  const sb = sanitizeControlPoints(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    if (sa[i].x !== sb[i].x || sa[i].y !== sb[i].y) return false;
  }
  return true;
}

/**
 * 与 WidgetNode.tsx 保持 100% 一致的多端口纵向位置计算：
 * 第 idx 个端口位于 node.y + node.height * ((idx + 1) / (ports.length + 1))。
 */
export function resolveNodePortY(
  node: { y: number; height: number; inputPorts?: NodePortSpec[]; outputPorts?: NodePortSpec[] },
  handleId?: string | null,
  kind: 'input' | 'output' = 'input'
): number {
  const rawPorts = kind === 'input' ? node.inputPorts : node.outputPorts;
  const ports =
    rawPorts === undefined
      ? kind === 'input'
        ? DEFAULT_INPUT_PORTS
        : DEFAULT_OUTPUT_PORTS
      : rawPorts;
  if (!Array.isArray(ports) || ports.length <= 1) {
    return node.y + node.height * 0.5;
  }
  // 缺省 handleId 时与 React Flow 默认连接首个端口的行为对齐（idx = 0）
  const idx = handleId ? ports.findIndex((p) => p.id === handleId) : 0;
  const resolvedIdx = idx < 0 ? 0 : idx;
  return node.y + node.height * ((resolvedIdx + 1) / (ports.length + 1));
}

/** 计算三次贝塞尔段在参数 t ∈ [0, 1] 上的精确坐标 B(t)。 */
export function evalCubicBezier(seg: CubicBezierSegment, t: number): EdgeControlPoint {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: u3 * seg.x0 + 3 * u2 * t * seg.cp1x + 3 * u * t2 * seg.cp2x + t3 * seg.x,
    y: u3 * seg.y0 + 3 * u2 * t * seg.cp1y + 3 * u * t2 * seg.cp2y + t3 * seg.y,
  };
}

/** 近似计算单段三次贝塞尔弧长（8 段折线采样）。 */
function approxSegmentLength(seg: CubicBezierSegment): number {
  let len = 0;
  let prev = { x: seg.x0, y: seg.y0 };
  const steps = 8;
  for (let s = 1; s <= steps; s++) {
    const cur = evalCubicBezier(seg, s / steps);
    len += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return len;
}

/**
 * 计算从起点经由全部控制点到终点的逐段三次贝塞尔曲线参数。
 * SVG 与 Canvas 2D 全景渲染共用此函数，确保缩远后走线与近景完全一致。
 */
export function computeControlPointBezierSegments(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  controlPoints?: EdgeControlPoint[]
): CubicBezierSegment[] {
  const cps = sanitizeControlPoints(controlPoints);
  if (cps.length === 0) {
    const dx = Math.max(48, Math.abs(targetX - sourceX) * 0.45);
    return [
      {
        x0: sourceX,
        y0: sourceY,
        cp1x: sourceX + dx,
        cp1y: sourceY,
        cp2x: targetX - dx,
        cp2y: targetY,
        x: targetX,
        y: targetY,
      },
    ];
  }

  const pts: EdgeControlPoint[] = [
    { x: sourceX, y: sourceY },
    ...cps,
    { x: targetX, y: targetY },
  ];

  const segments: CubicBezierSegment[] = [];
  const EPS = 1e-6;
  const knotStep = (a: EdgeControlPoint, b: EdgeControlPoint): number =>
    Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p0 = i > 0 ? pts[i - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    const p3 = i + 2 < pts.length ? pts[i + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };

    const d1 = knotStep(p0, p1);
    const d2 = knotStep(p1, p2);
    const d3 = knotStep(p2, p3);

    let cp1x: number;
    let cp1y: number;
    let cp2x: number;
    let cp2y: number;

    if (d2 < EPS) {
      cp1x = p1.x;
      cp1y = p1.y;
      cp2x = p2.x;
      cp2y = p2.y;
    } else {
      if (d1 < EPS) {
        cp1x = p1.x + (p2.x - p1.x) / 3;
        cp1y = p1.y + (p2.y - p1.y) / 3;
      } else {
        const d1Sq = d1 * d1;
        const d2Sq = d2 * d2;
        const denom1 = 3 * d1 * (d1 + d2);
        cp1x = p1.x + (d1Sq * (p2.x - p1.x) + d2Sq * (p1.x - p0.x)) / denom1;
        cp1y = p1.y + (d1Sq * (p2.y - p1.y) + d2Sq * (p1.y - p0.y)) / denom1;
      }

      if (d3 < EPS) {
        cp2x = p2.x - (p2.x - p1.x) / 3;
        cp2y = p2.y - (p2.y - p1.y) / 3;
      } else {
        const d2Sq = d2 * d2;
        const d3Sq = d3 * d3;
        const denom2 = 3 * d3 * (d3 + d2);
        cp2x = p2.x - (d3Sq * (p2.x - p1.x) + d2Sq * (p3.x - p2.x)) / denom2;
        cp2y = p2.y - (d3Sq * (p2.y - p1.y) + d2Sq * (p3.y - p2.y)) / denom2;
      }
    }

    segments.push({
      x0: p1.x,
      y0: p1.y,
      cp1x,
      cp1y,
      cp2x,
      cp2y,
      x: p2.x,
      y: p2.y,
    });
  }
  return segments;
}

/**
 * 给定起点、终点与若干控制点，生成平滑穿过所有控制点的 SVG path 与精确落在曲线上的标签中点及各段 "+" 锚点。
 */
export function buildControlPointEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  controlPoints?: EdgeControlPoint[]
): { path: string; labelX: number; labelY: number; segmentMidpoints: Array<{ x: number; y: number; insertIndex: number }> } {
  const cps = sanitizeControlPoints(controlPoints);
  const segments = computeControlPointBezierSegments(sourceX, sourceY, targetX, targetY, cps);

  if (cps.length === 0) {
    const seg = segments[0];
    const path = `M ${seg.x0} ${seg.y0} C ${seg.cp1x} ${seg.cp1y}, ${seg.cp2x} ${seg.cp2y}, ${seg.x} ${seg.y}`;
    const mid = evalCubicBezier(seg, 0.5);
    return {
      path,
      labelX: Math.round(mid.x),
      labelY: Math.round(mid.y),
      segmentMidpoints: [{ x: Math.round(mid.x), y: Math.round(mid.y), insertIndex: 0 }],
    };
  }

  const parts: string[] = [`M ${sourceX} ${sourceY}`];
  const segmentMidpoints: Array<{ x: number; y: number; insertIndex: number }> = [];
  const segLengths: number[] = [];
  let totalLen = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    parts.push(
      `C ${seg.cp1x.toFixed(1)} ${seg.cp1y.toFixed(1)}, ${seg.cp2x.toFixed(1)} ${seg.cp2y.toFixed(1)}, ${seg.x.toFixed(1)} ${seg.y.toFixed(1)}`
    );
    const curveMid = evalCubicBezier(seg, 0.5);
    segmentMidpoints.push({
      x: Math.round(curveMid.x),
      y: Math.round(curveMid.y),
      insertIndex: i,
    });
    const len = approxSegmentLength(seg);
    segLengths.push(len);
    totalLen += len;
  }

  // 标签放在整条三次贝塞尔曲线弧长 50% 的真实 B(t) 点上，不偏离大弧度曲线本体
  let labelPt = evalCubicBezier(segments[Math.floor(segments.length / 2)], 0.5);
  if (totalLen > 0) {
    let acc = 0;
    const half = totalLen / 2;
    for (let i = 0; i < segments.length; i++) {
      if (acc + segLengths[i] >= half && segLengths[i] > 0) {
        const t = Math.max(0, Math.min(1, (half - acc) / segLengths[i]));
        labelPt = evalCubicBezier(segments[i], t);
        break;
      }
      acc += segLengths[i];
    }
  }

  return {
    path: parts.join(' '),
    labelX: Math.round(labelPt.x),
    labelY: Math.round(labelPt.y),
    segmentMidpoints,
  };
}

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
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return safe;
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

export interface MinimalPointerEvent {
  button?: number;
  pointerId?: number;
  clientX: number;
  clientY: number;
}

export interface ControlPointDragSessionOptions {
  index: number;
  initialPoints: EdgeControlPoint[];
  isNewInsert: boolean;
  startEvent: MinimalPointerEvent;
  dragThresholdPx?: number;
  screenToFlow: (pt: { x: number; y: number }) => { x: number; y: number };
  onDraftChange: (draft: EdgeControlPoint[] | null) => void;
  onCommit?: (finalPoints: EdgeControlPoint[]) => void;
  addWindowListener: (type: 'pointermove' | 'pointerup' | 'pointercancel', fn: (ev: MinimalPointerEvent) => void) => void;
  removeWindowListener: (type: 'pointermove' | 'pointerup' | 'pointercancel', fn: (ev: MinimalPointerEvent) => void) => void;
}

/**
 * 可独立单测的控制点拖拽会话控制器：
 * - 拒绝非左键（button !== 0）与只读模式（!onCommit）；
 * - 按 pointerId 隔离多指触控；
 * - 对已有控制点施加 4px 屏幕位移阈值，避免双击删点时 1-2px 抖动触发空提交；
 * - pointercancel 严格回滚不提交（含新建 + 插入）；
 * - 返回 cleanup() 供组件卸载或删除操作立即注销全部 window 监听器。
 */
export function createControlPointDragSession(opts: ControlPointDragSessionOptions): (() => void) | null {
  if (!opts.onCommit) return null;
  if ((opts.startEvent.button ?? 0) !== 0) return null;
  if (!Number.isInteger(opts.index) || opts.index < 0 || opts.index >= opts.initialPoints.length) return null;

  const threshold = Math.max(0, opts.dragThresholdPx ?? CONTROL_POINT_DRAG_THRESHOLD_PX);
  const activePointerId = opts.startEvent.pointerId;
  const startScreenX = opts.startEvent.clientX;
  const startScreenY = opts.startEvent.clientY;
  let draft: EdgeControlPoint[] | null = opts.initialPoints.slice();
  let hasChanged = opts.isNewInsert;
  let thresholdPassed = opts.isNewInsert;
  let active = true;

  if (opts.isNewInsert) {
    opts.onDraftChange(draft);
  }

  const cleanup = () => {
    if (!active) return;
    active = false;
    opts.removeWindowListener('pointermove', handleMove);
    opts.removeWindowListener('pointerup', handleUp);
    opts.removeWindowListener('pointercancel', handleCancel);
    draft = null;
  };

  const isMatchingPointer = (ev: MinimalPointerEvent): boolean =>
    activePointerId === undefined || ev.pointerId === undefined || ev.pointerId === activePointerId;

  const handleMove = (ev: MinimalPointerEvent) => {
    if (!active || !draft || !isMatchingPointer(ev)) return;
    if (!thresholdPassed) {
      if (Math.hypot(ev.clientX - startScreenX, ev.clientY - startScreenY) < threshold) {
        return;
      }
      thresholdPassed = true;
    }
    const flowPos = opts.screenToFlow({ x: ev.clientX, y: ev.clientY });
    if (!Number.isFinite(flowPos.x) || !Number.isFinite(flowPos.y)) return;
    const rx = Math.round(flowPos.x);
    const ry = Math.round(flowPos.y);
    const cur = draft[opts.index];
    if (cur && cur.x === rx && cur.y === ry) return;
    hasChanged = true;
    const next = draft.slice();
    next[opts.index] = { x: rx, y: ry };
    draft = next;
    opts.onDraftChange(next);
  };

  const handleUp = (ev: MinimalPointerEvent) => {
    if (!active || !isMatchingPointer(ev)) return;
    const finalPoints = draft;
    const shouldCommit = hasChanged && Boolean(finalPoints);
    cleanup();
    opts.onDraftChange(null);
    if (shouldCommit && finalPoints && opts.onCommit) {
      opts.onCommit(finalPoints);
    }
  };

  const handleCancel = (ev: MinimalPointerEvent) => {
    if (!active || !isMatchingPointer(ev)) return;
    cleanup();
    opts.onDraftChange(null);
  };

  opts.addWindowListener('pointermove', handleMove);
  opts.addWindowListener('pointerup', handleUp);
  opts.addWindowListener('pointercancel', handleCancel);

  return cleanup;
}
