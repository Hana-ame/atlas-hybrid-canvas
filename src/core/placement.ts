/**
 * @file placement.ts
 * @description 新建 / 复制 / widgets.create() 自动寻空位算法：
 * - 绝不移动任何已有控件（零副作用、不触发 CRDT 连锁扩散）；
 * - 仅在期望位置与已有控件发生 AABB 重叠（含呼吸间距 gap）时，为新节点寻找最近的无重叠空位；
 * - 优先尝试贴靠障碍物右侧/下方，再按螺旋网格向外逐圈探测。
 */

export interface RectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementOptions {
  /** 控件之间保留的最小间距（像素，默认 20） */
  gap?: number;
  /** 螺旋网格探测步长（像素，默认 48） */
  step?: number;
  /** 最大螺旋搜索圈数（默认 18） */
  maxRings?: number;
}

export function rectsOverlap(a: RectBox, b: RectBox, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

export function hasAnyOverlap(candidate: RectBox, existing: readonly RectBox[], gap: number): boolean {
  for (let i = 0; i < existing.length; i++) {
    if (rectsOverlap(candidate, existing[i], gap)) return true;
  }
  return false;
}

/**
 * 为新控件寻找最近的无重叠坐标；若期望位置本就无重叠，原样返回。
 */
export function findNonOverlappingPosition(
  desired: RectBox,
  existing: readonly RectBox[],
  options?: PlacementOptions
): { x: number; y: number } {
  const gap = Math.max(0, options?.gap ?? 20);
  const step = Math.max(16, options?.step ?? 48);
  const maxRings = Math.max(2, options?.maxRings ?? 18);

  const startX = Math.round(desired.x);
  const startY = Math.round(desired.y);
  const width = Math.max(40, Math.round(desired.width));
  const height = Math.max(40, Math.round(desired.height));

  const initial: RectBox = { x: startX, y: startY, width, height };
  if (existing.length === 0 || !hasAnyOverlap(initial, existing, gap)) {
    return { x: startX, y: startY };
  }

  // 1) 优先尝试紧贴碰撞障碍物的右侧、下方、上方、左侧（最贴合流程图/画布排版直觉）
  const blockers = existing.filter((b) => rectsOverlap(initial, b, gap));
  const anchorCandidates: Array<{ x: number; y: number }> = [];
  for (const b of blockers) {
    anchorCandidates.push(
      { x: Math.round(b.x + b.width + gap), y: startY },
      { x: startX, y: Math.round(b.y + b.height + gap) },
      { x: Math.round(b.x + b.width + gap), y: Math.round(b.y) },
      { x: Math.round(b.x), y: Math.round(b.y + b.height + gap) },
      { x: Math.round(b.x - width - gap), y: startY },
      { x: startX, y: Math.round(b.y - height - gap) }
    );
  }

  let bestAnchor: { x: number; y: number; distSq: number } | null = null;
  for (const pt of anchorCandidates) {
    if (!hasAnyOverlap({ x: pt.x, y: pt.y, width, height }, existing, gap)) {
      const dx = pt.x - startX;
      const dy = pt.y - startY;
      // 略微偏好向右/向下顺延，符合阅读方向
      const bias = (dx < 0 ? 1.15 : 1) * (dy < 0 ? 1.15 : 1);
      const distSq = (dx * dx + dy * dy) * bias;
      if (!bestAnchor || distSq < bestAnchor.distSq) {
        bestAnchor = { x: pt.x, y: pt.y, distSq };
      }
    }
  }
  if (bestAnchor) {
    return { x: bestAnchor.x, y: bestAnchor.y };
  }

  // 2) 障碍物密集时，按螺旋网格逐圈向外寻找最近空位
  const stepX = Math.max(step, Math.round((width + gap) / 3));
  const stepY = Math.max(step, Math.round((height + gap) / 3));
  for (let ring = 1; ring <= maxRings; ring++) {
    let bestInRing: { x: number; y: number; distSq: number } | null = null;
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        if (Math.abs(gx) !== ring && Math.abs(gy) !== ring) continue;
        const cx = startX + gx * stepX;
        const cy = startY + gy * stepY;
        if (!hasAnyOverlap({ x: cx, y: cy, width, height }, existing, gap)) {
          const dx = cx - startX;
          const dy = cy - startY;
          const distSq = dx * dx + dy * dy;
          if (!bestInRing || distSq < bestInRing.distSq) {
            bestInRing = { x: cx, y: cy, distSq };
          }
        }
      }
    }
    if (bestInRing) {
      return { x: bestInRing.x, y: bestInRing.y };
    }
  }

  // 极端密集兜底：放到最右侧障碍物之外
  let maxRight = startX;
  for (const b of existing) {
    if (b.x + b.width + gap > maxRight) maxRight = Math.round(b.x + b.width + gap);
  }
  return { x: maxRight, y: startY };
}
