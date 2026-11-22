import { useLayoutEffect, useRef } from 'react';
import { useViewport } from '@xyflow/react';
import type { ChunkManager } from '../core/chunkManager';
import type { ChunkTileCache } from '../core/chunkTileCache';
import type {
  CanvasAnnotation,
  EffectiveBlueprintNode,
  LODLevel,
} from '../core/types';

interface ChunkUnderlayCanvasProps {
  chunkManager: ChunkManager;
  tileCache: ChunkTileCache;
  nodes: Record<string, EffectiveBlueprintNode>;
  annotations: Record<string, CanvasAnnotation>;
  lod: LODLevel;
  showChunkGrid: boolean;
  annotationEditMode: boolean;
  renderVersion: number;
}

const MAX_BAKES_PER_FRAME = 6;
const MAX_BAKE_MS = 6;

/** 按世界宽度截断文字，只保留能清晰放下的前几个字 + 省略号，绝不压扁成蚂蚁字 */
function truncateTextToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (maxWidth <= 8 || !text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  const ellipsisW = ctx.measureText(ellipsis).width;
  if (ellipsisW >= maxWidth) return text.slice(0, 1);

  let lo = 1;
  let hi = text.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = ctx.measureText(text.slice(0, mid)).width + ellipsisW;
    if (w <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, best) + ellipsis;
}

/**
 * 与 React Flow 视口矩阵像素级对齐的底层 Canvas 2D 瓦片与注释层：
 * - useLayoutEffect 同步首帧绘制，与 React Flow DOM 同帧渲染不频闪
 * - 全景（macro）下：色块走离屏瓦片缓存，标题与区域注释按屏幕像素补偿放大绘制并按宽截断，缩远依然清晰可读
 */
export function ChunkUnderlayCanvas({
  chunkManager,
  tileCache,
  nodes,
  annotations,
  lod,
  showChunkGrid,
  annotationEditMode,
  renderVersion,
}: ChunkUnderlayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vp = useViewport();

  useLayoutEffect(() => {
    let rafId = 0;
    let cancelled = false;

    const draw = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (width <= 0 || height <= 0) return;

      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(0, 0, width, height);

      // 与 React Flow 左上角视口矩阵严丝合缝对齐
      ctx.save();
      ctx.translate(vp.x, vp.y);
      ctx.scale(vp.zoom, vp.zoom);

      const worldBounds = {
        minX: -vp.x / vp.zoom - 64,
        minY: -vp.y / vp.zoom - 64,
        maxX: (width - vp.x) / vp.zoom + 64,
        maxY: (height - vp.y) / vp.zoom + 64,
      };

      const cs = chunkManager.chunkSize;
      // 1) 512x512 Chunk 分区线与坐标水印
      if (showChunkGrid) {
        const minCx = Math.floor(worldBounds.minX / cs);
        const maxCx = Math.floor(worldBounds.maxX / cs);
        const minCy = Math.floor(worldBounds.minY / cs);
        const maxCy = Math.floor(worldBounds.maxY / cs);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
        ctx.lineWidth = Math.max(1 / vp.zoom, 0.8);
        ctx.beginPath();
        for (let cx = minCx; cx <= maxCx + 1; cx++) {
          ctx.moveTo(cx * cs, minCy * cs);
          ctx.lineTo(cx * cs, (maxCy + 1) * cs);
        }
        for (let cy = minCy; cy <= maxCy + 1; cy++) {
          ctx.moveTo(minCx * cs, cy * cs);
          ctx.lineTo((maxCx + 1) * cs, cy * cs);
        }
        ctx.stroke();

        ctx.fillStyle = 'rgba(100, 116, 139, 0.55)';
        ctx.font = `500 ${Math.max(11, Math.min(24, 11 / vp.zoom))}px ui-monospace, SFMono-Regular, monospace`;
        ctx.textBaseline = 'top';
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            ctx.fillText(`(${cx}, ${cy})`, cx * cs + 8, cy * cs + 6);
          }
        }
      }

      // 2) 可见 Chunk 离屏瓦片烘焙与绘制（带帧预算防卡顿）
      const visibleChunks = chunkManager.queryVisibleChunks(worldBounds);
      const tileScale = lod === 'macro' ? 0.35 : lod === 'meso' ? 0.65 : 1.0;
      const drawAnnotationsInTile = lod !== 'macro' && !annotationEditMode;
      let bakesThisFrame = 0;
      let hasPendingBakes = false;
      const bakeStart = performance.now();

      for (const chunk of visibleChunks) {
        if (lod !== 'macro' && (!drawAnnotationsInTile || chunk.annotationIds.size === 0)) {
          continue;
        }
        if (lod === 'macro' && chunk.nodeIds.size === 0) {
          continue;
        }

        let tile = tileCache.get(chunk, lod, tileScale);
        if (!tile) {
          const withinBudget =
            bakesThisFrame < MAX_BAKES_PER_FRAME &&
            (bakesThisFrame === 0 || performance.now() - bakeStart < MAX_BAKE_MS);

          if (withinBudget) {
            tile = tileCache.bake(chunk, cs, lod, tileScale, (bctx) => {
              // 中/近景且未处于注释编辑态时，将背景注释烘焙进离屏瓦片
              if (drawAnnotationsInTile) {
                for (const annId of chunk.annotationIds) {
                  const ann = annotations[annId];
                  if (!ann) continue;
                  bctx.fillStyle = ann.color;
                  bctx.font = `${ann.weight === 'bold' ? '700' : '400'} ${ann.fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
                  bctx.textBaseline = 'top';
                  bctx.fillText(ann.text, ann.x, ann.y, ann.width);
                }
              }

              // 全景（macro）下只把节点色块与边框烘焙进瓦片；标题单独用屏幕补偿大字绘制，保证缩远清晰
              if (lod === 'macro') {
                for (const nodeId of chunk.nodeIds) {
                  const n = nodes[nodeId];
                  if (!n) continue;
                  bctx.fillStyle = `${n.color}26`;
                  bctx.strokeStyle = n.color;
                  bctx.lineWidth = 3;
                  bctx.fillRect(n.x, n.y, n.width, n.height);
                  bctx.strokeRect(n.x, n.y, n.width, n.height);
                }
              }
            });
            chunkManager.markClean(chunk.key);
            bakesThisFrame++;
          } else {
            tile = tileCache.getFallback(chunk);
            hasPendingBakes = true;
          }
        }

        if (tile) {
          ctx.drawImage(tile.canvas, chunk.bounds.minX, chunk.bounds.minY, cs, cs);
        }
      }

      // 3) 全景（macro）清晰大字层：按屏幕像素补偿放大（始终约 13~16px 清晰可读），超出节点宽自动截断显示前几个字
      if (lod === 'macro') {
        const seenNodes = new Set<string>();
        const seenAnns = new Set<string>();

        // 3a) 节点大字标题（截断前几个字，带白描边防色块干扰）
        const targetNodeScreenPx = 13.5;
        const haloWidth = 3 / vp.zoom;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';

        for (const chunk of visibleChunks) {
          for (const nodeId of chunk.nodeIds) {
            if (seenNodes.has(nodeId)) continue;
            seenNodes.add(nodeId);
            const n = nodes[nodeId];
            if (!n) continue;
            // 节点在屏幕上太小（< 22px 宽）时跳过避免糊成一团
            if (n.width * vp.zoom < 22 || n.height * vp.zoom < 14) continue;

            // 尽量放大到屏幕 13.5px，同时不撑破节点高度
            const worldFontPx = Math.min(
              targetNodeScreenPx / vp.zoom,
              Math.max(20, n.height * 0.62)
            );
            ctx.font = `700 ${worldFontPx}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
            const padX = Math.max(6, Math.min(14, n.width * 0.08));
            const label = truncateTextToWidth(ctx, n.title, n.width - padX * 2);
            if (!label) continue;

            const tx = n.x + padX;
            const ty = n.y + n.height * 0.5;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.lineWidth = haloWidth;
            ctx.strokeText(label, tx, ty);
            ctx.fillStyle = '#0F172A';
            ctx.fillText(label, tx, ty);
          }
        }

        // 3b) 区域背景注释在全景下同样按屏幕像素补偿放大（约 15px 清晰区域标牌）
        const targetAnnScreenPx = 15;
        ctx.textBaseline = 'top';
        for (const chunk of visibleChunks) {
          for (const annId of chunk.annotationIds) {
            if (seenAnns.has(annId)) continue;
            seenAnns.add(annId);
            const ann = annotations[annId];
            if (!ann) continue;

            const annWorldFontPx = Math.max(ann.fontSize, targetAnnScreenPx / vp.zoom);
            ctx.font = `700 ${annWorldFontPx}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
            const label = truncateTextToWidth(ctx, ann.text, Math.max(ann.width, cs - 24));
            if (!label) continue;

            ctx.strokeStyle = 'rgba(248, 250, 252, 0.95)';
            ctx.lineWidth = 4 / vp.zoom;
            ctx.strokeText(label, ann.x, ann.y);
            ctx.fillStyle = ann.color;
            ctx.fillText(label, ann.x, ann.y);
          }
        }
      }

      ctx.restore();

      if (hasPendingBakes && !cancelled) {
        rafId = requestAnimationFrame(draw);
      }
    };

    // 同步首帧绘制，确保与 React Flow DOM 帧同步不频闪
    draw();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [
    vp.x,
    vp.y,
    vp.zoom,
    chunkManager,
    tileCache,
    nodes,
    annotations,
    lod,
    showChunkGrid,
    annotationEditMode,
    renderVersion,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 0 }}
    />
  );
}
