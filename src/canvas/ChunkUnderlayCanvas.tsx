import { memo, useEffect, useRef } from 'react';
import { useStoreApi } from '@xyflow/react';
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

function hexToRgba(hex: string | undefined, opacity: number): string | null {
  if (!hex || hex === 'transparent' || opacity <= 0) return null;
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 多行按宽换行（绝不压扁拉伸字体） */
function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [];
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (!para) {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const ch of para) {
      const next = cur + ch;
      if (cur && ctx.measureText(next).width > maxWidth) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

function truncateTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
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
    if (ctx.measureText(text.slice(0, mid)).width + ellipsisW <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, best) + ellipsis;
}

function ChunkUnderlayCanvasInner(props: ChunkUnderlayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const store = useStoreApi();
  const propsRef = useRef(props);
  propsRef.current = props;

  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const drawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let pendingRaf = 0;
    let lastTx = NaN;
    let lastTy = NaN;
    let lastZoom = NaN;
    let lastVersion = -1;

    const getLoadedImage = (url: string): HTMLImageElement | null => {
      const cache = imgCacheRef.current;
      let img = cache.get(url);
      if (!img) {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          propsRef.current.tileCache.clear();
          draw(true);
        };
        img.src = url;
        cache.set(url, img);
      }
      return img.complete && img.naturalWidth > 0 ? img : null;
    };

    const drawAnnotation = (bctx: CanvasRenderingContext2D, ann: CanvasAnnotation) => {
      const h = ann.height || Math.max(48, ann.fontSize * 2.5);
      const fill = hexToRgba(ann.bgColor, ann.bgOpacity ?? 0.85);
      if (fill) {
        bctx.fillStyle = fill;
        drawRoundedRect(bctx, ann.x, ann.y, ann.width, h, 8);
        bctx.fill();
      }

      if (ann.kind === 'image' && ann.imageUrl) {
        const img = getLoadedImage(ann.imageUrl);
        if (img) {
          // 严格按自然宽高比 contain 绘制，绝不拉伸变形！
          const pad = 8;
          const availW = Math.max(8, ann.width - pad * 2);
          const availH = Math.max(8, h - pad * 2);
          const scale = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
          const drawW = img.naturalWidth * scale;
          const drawH = img.naturalHeight * scale;
          const dx = ann.x + pad + (availW - drawW) * 0.5;
          const dy = ann.y + pad + (availH - drawH) * 0.5;
          bctx.drawImage(img, dx, dy, drawW, drawH);
        }
        return;
      }

      const pad = 10;
      bctx.fillStyle = ann.color;
      bctx.font = `${ann.weight === 'bold' ? '700' : '400'} ${ann.fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      bctx.textBaseline = 'top';
      const lines = wrapTextLines(bctx, ann.text, Math.max(24, ann.width - pad * 2));
      const lineHeight = ann.fontSize * 1.38;
      for (let i = 0; i < lines.length; i++) {
        const ly = ann.y + pad + i * lineHeight;
        if (ly + ann.fontSize > ann.y + h + 4) break;
        bctx.fillText(lines[i], ann.x + pad, ly);
      }
    };

    const draw = (force = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      const [tx, ty, zoom] = store.getState().transform;
      const p = propsRef.current;
      if (
        !force &&
        tx === lastTx &&
        ty === lastTy &&
        zoom === lastZoom &&
        p.renderVersion === lastVersion
      ) {
        return;
      }
      lastTx = tx;
      lastTy = ty;
      lastZoom = zoom;
      lastVersion = p.renderVersion;

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

      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(zoom, zoom);

      const worldBounds = {
        minX: -tx / zoom - 64,
        minY: -ty / zoom - 64,
        maxX: (width - tx) / zoom + 64,
        maxY: (height - ty) / zoom + 64,
      };

      const cs = p.chunkManager.chunkSize;
      if (p.showChunkGrid) {
        const minCx = Math.floor(worldBounds.minX / cs);
        const maxCx = Math.floor(worldBounds.maxX / cs);
        const minCy = Math.floor(worldBounds.minY / cs);
        const maxCy = Math.floor(worldBounds.maxY / cs);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
        ctx.lineWidth = Math.max(1 / zoom, 0.8);
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
        ctx.font = `500 ${Math.max(11, Math.min(24, 11 / zoom))}px ui-monospace, SFMono-Regular, monospace`;
        ctx.textBaseline = 'top';
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            ctx.fillText(`(${cx}, ${cy})`, cx * cs + 8, cy * cs + 6);
          }
        }
      }

      const visibleChunks = p.chunkManager.queryVisibleChunks(worldBounds);
      const tileScale = p.lod === 'macro' ? 0.35 : p.lod === 'meso' ? 0.65 : 1.0;
      const drawAnnotationsInTile = !p.annotationEditMode;
      let bakesThisFrame = 0;
      let hasPendingBakes = false;
      const bakeStart = performance.now();

      for (const chunk of visibleChunks) {
        if (p.lod !== 'macro' && (!drawAnnotationsInTile || chunk.annotationIds.size === 0)) {
          continue;
        }
        if (p.lod === 'macro' && chunk.nodeIds.size === 0 && chunk.annotationIds.size === 0) {
          continue;
        }

        let tile = p.tileCache.get(chunk, p.lod, tileScale);
        if (!tile) {
          const withinBudget =
            bakesThisFrame < MAX_BAKES_PER_FRAME &&
            (bakesThisFrame === 0 || performance.now() - bakeStart < MAX_BAKE_MS);

          if (withinBudget) {
            tile = p.tileCache.bake(chunk, cs, p.lod, tileScale, (bctx) => {
              if (drawAnnotationsInTile) {
                for (const annId of chunk.annotationIds) {
                  const ann = p.annotations[annId];
                  if (!ann) continue;
                  // Macro 下背景色块和插图进瓦片，文字标题留在下面大字层清晰绘制
                  if (p.lod === 'macro' && ann.kind === 'text') {
                    const fill = hexToRgba(ann.bgColor, ann.bgOpacity ?? 0.85);
                    if (fill) {
                      bctx.fillStyle = fill;
                      drawRoundedRect(bctx, ann.x, ann.y, ann.width, ann.height || 56, 8);
                      bctx.fill();
                    }
                  } else {
                    drawAnnotation(bctx, ann);
                  }
                }
              }

              if (p.lod === 'macro') {
                for (const nodeId of chunk.nodeIds) {
                  const n = p.nodes[nodeId];
                  if (!n) continue;
                  bctx.fillStyle = `${n.color}26`;
                  bctx.strokeStyle = n.color;
                  bctx.lineWidth = 3;
                  bctx.fillRect(n.x, n.y, n.width, n.height);
                  bctx.strokeRect(n.x, n.y, n.width, n.height);
                }
              }
            });
            p.chunkManager.markClean(chunk.key);
            bakesThisFrame++;
          } else {
            tile = p.tileCache.getFallback(chunk);
            hasPendingBakes = true;
          }
        }

        if (tile) {
          ctx.drawImage(tile.canvas, chunk.bounds.minX, chunk.bounds.minY, cs, cs);
        }
      }

      // 全景（macro）清晰大字层
      if (p.lod === 'macro') {
        const seenNodes = new Set<string>();
        const seenAnns = new Set<string>();
        const targetNodeScreenPx = 13.5;
        const haloWidth = 3 / zoom;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';

        for (const chunk of visibleChunks) {
          for (const nodeId of chunk.nodeIds) {
            if (seenNodes.has(nodeId)) continue;
            seenNodes.add(nodeId);
            const n = p.nodes[nodeId];
            if (!n) continue;
            if (n.width * zoom < 22 || n.height * zoom < 14) continue;

            const worldFontPx = Math.min(
              targetNodeScreenPx / zoom,
              Math.max(20, n.height * 0.62)
            );
            ctx.font = `700 ${worldFontPx}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
            const padX = Math.max(6, Math.min(14, n.width * 0.08));
            const label = truncateTextToWidth(ctx, n.title, n.width - padX * 2);
            if (!label) continue;

            const txPos = n.x + padX;
            const tyPos = n.y + n.height * 0.5;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.lineWidth = haloWidth;
            ctx.strokeText(label, txPos, tyPos);
            ctx.fillStyle = '#0F172A';
            ctx.fillText(label, txPos, tyPos);
          }
        }

        const targetAnnScreenPx = 15;
        ctx.textBaseline = 'top';
        for (const chunk of visibleChunks) {
          for (const annId of chunk.annotationIds) {
            if (seenAnns.has(annId)) continue;
            seenAnns.add(annId);
            const ann = p.annotations[annId];
            if (!ann || ann.kind === 'image') continue;

            const annWorldFontPx = Math.max(ann.fontSize, targetAnnScreenPx / zoom);
            ctx.font = `700 ${annWorldFontPx}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
            const firstLine = (ann.text || '').split('\n')[0];
            const label = truncateTextToWidth(ctx, firstLine, Math.max(ann.width, cs - 24));
            if (!label) continue;

            ctx.strokeStyle = 'rgba(248, 250, 252, 0.95)';
            ctx.lineWidth = 4 / zoom;
            ctx.strokeText(label, ann.x + 8, ann.y + 8);
            ctx.fillStyle = ann.color;
            ctx.fillText(label, ann.x + 8, ann.y + 8);
          }
        }
      }

      ctx.restore();

      if (hasPendingBakes && !pendingRaf) {
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          draw(true);
        });
      }
    };

    drawRef.current = () => draw(true);

    const unsubscribe = store.subscribe(() => {
      draw(false);
    });

    const onResize = () => draw(true);
    window.addEventListener('resize', onResize);
    draw(true);

    return () => {
      unsubscribe();
      window.removeEventListener('resize', onResize);
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
    };
  }, [store]);

  useEffect(() => {
    drawRef.current?.();
  }, [props.renderVersion, props.lod, props.showChunkGrid, props.annotationEditMode, props.annotations]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 0 }}
    />
  );
}

export const ChunkUnderlayCanvas = memo(ChunkUnderlayCanvasInner);
