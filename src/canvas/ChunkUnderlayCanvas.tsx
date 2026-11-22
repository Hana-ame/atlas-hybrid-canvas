import { useEffect, useRef } from 'react';
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
  renderVersion: number;
}

const MAX_BAKES_PER_FRAME = 4;
const MAX_BAKE_MS = 4.5;

/**
 * 与 React Flow 视口矩阵像素级对齐的底层 Canvas 2D 瓦片与注释层：
 * 1) 始终绘制无限 512x512 分区网格与“不可交互背景注释文本”（点击直接穿透）
 * 2) 当 LOD === 'macro'（缩远 < 32%）时，接管所有节点的离屏瓦片烘焙绘制，上层 React Flow 挂载 0 个 DOM 节点
 */
export function ChunkUnderlayCanvas({
  chunkManager,
  tileCache,
  nodes,
  annotations,
  lod,
  showChunkGrid,
  renderVersion,
}: ChunkUnderlayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vp = useViewport();

  useEffect(() => {
    let rafId = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
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
        ctx.font = `500 ${Math.max(11, Math.min(22, 11 / vp.zoom))}px ui-monospace, SFMono-Regular, monospace`;
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            ctx.fillText(`(${cx}, ${cy})`, cx * cs + 8, cy * cs + 18 / Math.min(vp.zoom, 1));
          }
        }
      }

      // 2) 可见 Chunk 离屏瓦片烘焙与绘制（带帧预算防卡顿）
      const visibleChunks = chunkManager.queryVisibleChunks(worldBounds);
      const tileScale = lod === 'macro' ? 0.35 : lod === 'meso' ? 0.65 : 1.0;
      let bakesThisFrame = 0;
      let hasPendingBakes = false;
      const bakeStart = performance.now();

      for (const chunk of visibleChunks) {
        let tile = tileCache.get(chunk, lod, tileScale);
        if (!tile) {
          const withinBudget =
            bakesThisFrame < MAX_BAKES_PER_FRAME &&
            (bakesThisFrame === 0 || performance.now() - bakeStart < MAX_BAKE_MS);

          if (withinBudget) {
            tile = tileCache.bake(chunk, cs, lod, tileScale, (bctx) => {
              // 总是将不可交互背景注释烘焙进瓦片
              for (const annId of chunk.annotationIds) {
                const ann = annotations[annId];
                if (!ann) continue;
                bctx.fillStyle = ann.color;
                bctx.font = `${ann.weight === 'bold' ? '700' : '400'} ${ann.fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
                bctx.textBaseline = 'top';
                bctx.fillText(ann.text, ann.x, ann.y, ann.width);
              }

              // 在 Macro 视图下，把节点也简化烘焙进离屏瓦片（此时上层 React Flow 挂载 0 个 DOM 节点）
              if (lod === 'macro') {
                for (const nodeId of chunk.nodeIds) {
                  const n = nodes[nodeId];
                  if (!n) continue;
                  bctx.fillStyle = `${n.color}22`;
                  bctx.strokeStyle = n.color;
                  bctx.lineWidth = 2;
                  bctx.fillRect(n.x, n.y, n.width, n.height);
                  bctx.strokeRect(n.x, n.y, n.width, n.height);

                  bctx.fillStyle = '#0F172A';
                  bctx.font = '700 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
                  bctx.textBaseline = 'top';
                  bctx.fillText(n.title, n.x + 8, n.y + 8, Math.max(24, n.width - 16));
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
        } else {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
          ctx.fillRect(chunk.bounds.minX + 8, chunk.bounds.minY + 8, cs - 16, cs - 16);
        }
      }

      ctx.restore();

      if (hasPendingBakes) {
        rafId = requestAnimationFrame(draw);
      }
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [vp.x, vp.y, vp.zoom, chunkManager, tileCache, nodes, annotations, lod, showChunkGrid, renderVersion]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 0 }}
    />
  );
}
