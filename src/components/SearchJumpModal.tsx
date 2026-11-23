/**
 * @file SearchJumpModal.tsx
 * @description 全局快速定位弹窗（Ctrl+K / Cmd+K）：
 * - 支持按标题、正文、分类、ID 模糊搜索全部控件与背景注释并一键飞跃；
 * - 支持直接输入 Chunk 坐标如 `1,-1` 或 `0,0@0.85` 精确跳转。
 */
import { useEffect, useMemo, useState } from 'react';
import { Compass, Search, X } from 'lucide-react';
import type { CanvasAnnotation, EffectiveBlueprintNode } from '../core/types';

interface SearchJumpModalProps {
  open: boolean;
  nodes: Record<string, EffectiveBlueprintNode>;
  annotations: Record<string, CanvasAnnotation>;
  onClose: () => void;
  onJumpToPoint: (worldX: number, worldY: number, zoom?: number, selectNodeId?: string) => void;
}

export function SearchJumpModal({
  open,
  nodes,
  annotations,
  onClose,
  onJumpToPoint,
}: SearchJumpModalProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const parsedChunk = useMemo(() => {
    const m = query.trim().match(/^(-?\d+)\s*[,，\s]\s*(-?\d+)(?:\s*@\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    return {
      cx: Number(m[1]),
      cy: Number(m[2]),
      zoom: m[3] ? Math.max(0.15, Math.min(2.2, Number(m[3]))) : 0.85,
    };
  }, [query]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Array<{
      id: string;
      kind: 'node' | 'annotation';
      title: string;
      subtitle: string;
      color: string;
      cx: number;
      cy: number;
      targetX: number;
      targetY: number;
    }> = [];

    for (const n of Object.values(nodes)) {
      const title = n.title ?? '';
      const body = n.body ?? '';
      if (
        !q ||
        title.toLowerCase().includes(q) ||
        body.toLowerCase().includes(q) ||
        (n.category || '').toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q)
      ) {
        out.push({
          id: n.id,
          kind: 'node',
          title: n.title,
          subtitle: `${n.category || '控件'} · Chunk (${Math.floor(n.x / 512)}, ${Math.floor(n.y / 512)})`,
          color: n.color,
          cx: Math.floor(n.x / 512),
          cy: Math.floor(n.y / 512),
          targetX: n.x + n.width * 0.5,
          targetY: n.y + n.height * 0.5,
        });
      }
    }

    for (const a of Object.values(annotations)) {
      const text = a.text ?? '';
      if (!q || text.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) {
        out.push({
          id: a.id,
          kind: 'annotation',
          title: text.split('\n')[0] || (a.kind === 'image' ? '背景插图' : '背景注释'),
          subtitle: `${a.kind === 'image' ? '背景插图' : '背景注释'} · Chunk (${Math.floor(a.x / 512)}, ${Math.floor(a.y / 512)})`,
          color: a.color || '#0F766E',
          cx: Math.floor(a.x / 512),
          cy: Math.floor(a.y / 512),
          targetX: a.x + a.width * 0.5,
          targetY: a.y + (a.height || 50) * 0.5,
        });
      }
    }

    return out.slice(0, 30);
  }, [query, nodes, annotations]);

  if (!open) return null;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-start justify-center bg-slate-900/35 pt-20 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-3.5 py-2.5">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter') {
                if (parsedChunk) {
                  onJumpToPoint(parsedChunk.cx * 512 + 256, parsedChunk.cy * 512 + 256, parsedChunk.zoom);
                  onClose();
                } else if (matches[0]) {
                  onJumpToPoint(
                    matches[0].targetX,
                    matches[0].targetY,
                    0.95,
                    matches[0].kind === 'node' ? matches[0].id : undefined
                  );
                  onClose();
                }
              }
            }}
            placeholder="搜节点标题/注释，或输 Chunk 坐标如 1,-1 或 0,0@0.8 …"
            className="flex-1 bg-transparent text-sm text-slate-900 outline-none"
          />
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {parsedChunk && (
            <button
              type="button"
              onClick={() => {
                onJumpToPoint(parsedChunk.cx * 512 + 256, parsedChunk.cy * 512 + 256, parsedChunk.zoom);
                onClose();
              }}
              className="mb-1.5 flex w-full items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-left text-xs font-semibold text-blue-800 hover:bg-blue-100"
            >
              <Compass className="h-4 w-4" />
              精确跃迁到 Chunk ({parsedChunk.cx}, {parsedChunk.cy}) · 缩放 {Math.round(parsedChunk.zoom * 100)}%
            </button>
          )}

          {matches.length === 0 && !parsedChunk && (
            <div className="py-8 text-center text-xs text-slate-400">未找到匹配的节点或注释</div>
          )}

          {matches.map((item) => (
            <button
              key={`${item.kind}-${item.id}`}
              type="button"
              onClick={() => {
                onJumpToPoint(item.targetX, item.targetY, 0.95, item.kind === 'node' ? item.id : undefined);
                onClose();
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-900">{item.title}</div>
                  <div className="truncate font-mono text-[10px] text-slate-400">{item.subtitle}</div>
                </div>
              </div>
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                飞跃
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
