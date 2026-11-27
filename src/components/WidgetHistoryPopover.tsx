/**
 * @file WidgetHistoryPopover.tsx
 * @description 控件级版本历史浮窗 —— 从房间级快照中展示历史条目，
 * 每个控件卡片右上角的「历史」按钮直接打开此浮窗，无需进入二级菜单。
 */

import { useMemo } from 'react';
import { History, X } from 'lucide-react';
import type { RoomHistoryEntryItem } from './VersionHistoryDrawer';

export { type RoomHistoryEntryItem };

interface WidgetHistoryPopoverProps {
  open: boolean;
  nodeId: string;
  nodeTitle: string;
  entries: RoomHistoryEntryItem[];
  loading: boolean;
  onClose: () => void;
}

/** Action badge styling – mirrors the mapping in VersionHistoryDrawer. */
const ACTION_META: Record<string, { label: string; badgeClass: string; dotClass: string }> = {
  publish: {
    label: '发布',
    badgeClass: 'border-blue-200 bg-blue-50 text-blue-700',
    dotClass: 'bg-blue-600',
  },
  agent: {
    label: 'Agent',
    badgeClass: 'border-violet-200 bg-violet-50 text-violet-700',
    dotClass: 'bg-violet-600',
  },
  collab: {
    label: '协同',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dotClass: 'bg-emerald-600',
  },
  rollback: {
    label: '回档',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-800',
    dotClass: 'bg-amber-500',
  },
};

function formatHistoryTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/**
 * A compact floating card that shows per-widget version history.
 *
 * Currently shows room-level history entries (per-widget snapshot diffing
 * is planned as a future enhancement).
 */
export function WidgetHistoryPopover({
  open,
  nodeId: _nodeId,
  nodeTitle,
  entries,
  loading,
  onClose,
}: WidgetHistoryPopoverProps) {
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.version - a.version || b.ts - a.ts),
    [entries]
  );

  if (!open) return null;

  return (
    <div
      aria-label={`${nodeTitle} 变更历史`}
      className="nodrag nopan nowheel absolute -top-2 right-0 z-50 w-72 translate-x-[calc(100%+8px)] rounded-lg border border-slate-200 bg-white/97 shadow-xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-1.5 border-b border-slate-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <History className="h-3.5 w-3.5 shrink-0 text-blue-700" />
          <span className="truncate text-xs font-bold text-slate-900">{nodeTitle}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            {sortedEntries.length} 条
          </span>
          <button
            type="button"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 历史条目列表 */}
      <div className="max-h-[280px] min-h-[48px] overflow-y-auto px-3 py-2">
        {loading ? (
          <div className="py-4 text-center text-[11px] text-slate-400">加载中…</div>
        ) : sortedEntries.length === 0 ? (
          <div className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[11px] leading-relaxed text-slate-500">
            暂无此控件的后端历史记录
          </div>
        ) : (
          <div className="space-y-1.5">
            {sortedEntries.map((item) => {
              const meta = ACTION_META[item.action] ?? {
                label: item.action,
                badgeClass: 'border-slate-200 bg-slate-100 text-slate-700',
                dotClass: 'bg-slate-400',
              };
              return (
                <div
                  key={item.version}
                  className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] transition-colors hover:border-slate-300 hover:bg-slate-50/50"
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotClass}`} />
                    <span className="font-mono text-[10px] font-bold text-slate-800">v{item.version}</span>
                    <span className={`rounded border px-1 py-px text-[9px] font-medium ${meta.badgeClass}`}>
                      {meta.label}
                    </span>
                    <span className="ml-auto font-mono text-[9px] text-slate-400">
                      {formatHistoryTime(item.ts)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] leading-snug text-slate-600">
                    {item.summary}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
        当前控件变更记录 · 回档请使用顶栏「版本历史」
      </div>
    </div>
  );
}
