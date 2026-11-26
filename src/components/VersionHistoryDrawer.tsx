import { useEffect, useMemo, useState } from 'react';
import { History, KeyRound, RefreshCw, RotateCcw, X } from 'lucide-react';

export interface RoomHistoryEntryItem {
  version: number;
  ts: number;
  action: string;
  actor: string;
  summary: string;
}

interface VersionHistoryDrawerProps {
  open: boolean;
  roomName: string;
  entries: RoomHistoryEntryItem[];
  loading: boolean;
  submitting: boolean;
  saveKey: string;
  error: string | null;
  onChangeSaveKey: (nextKey: string) => void;
  onRefresh: () => void;
  onRollback: (version: number) => Promise<boolean>;
  onClose: () => void;
}

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
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

export function VersionHistoryDrawer({
  open,
  roomName,
  entries,
  loading,
  submitting,
  saveKey,
  error,
  onChangeSaveKey,
  onRefresh,
  onRollback,
  onClose,
}: VersionHistoryDrawerProps) {
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);

  useEffect(() => {
    if (!open) setConfirmVersion(null);
  }, [open]);

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.version - a.version || b.ts - a.ts),
    [entries]
  );
  const latestVersion = sortedEntries[0]?.version ?? null;

  if (!open) return null;

  const handleConfirmRollback = async (version: number) => {
    const ok = await onRollback(version);
    if (ok) setConfirmVersion(null);
  };

  return (
    <aside
      aria-label="房间版本历史与回档"
      className="pointer-events-auto absolute top-16 right-3 bottom-12 z-30 flex w-96 flex-col rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur max-md:top-auto max-md:right-2 max-md:left-2 max-md:bottom-2 max-md:h-[60vh] max-md:w-auto max-md:rounded-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <History className="h-4 w-4 shrink-0 text-blue-700" />
            <span className="truncate text-sm font-bold text-slate-900">版本历史</span>
            <span className="max-w-[140px] truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
              {roomName}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            共 {sortedEntries.length} 条服务端快照记录
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="刷新版本历史"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <button
            type="button"
            title="关闭版本历史"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="border-b border-slate-100 bg-slate-50/75 px-4 py-2 text-[11px] leading-relaxed text-slate-600">
        回档会写入一条新的 <code className="rounded bg-white px-1 font-mono">rollback</code> 版本记录并广播给房间内协作者，原有历史快照仍保留，可随时恢复至较新版本。
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {sortedEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3.5 py-6 text-center text-xs leading-relaxed text-slate-500">
            暂无后端修改记录。
            <br />
            管理员发布、Agent 操作或协同自动保存后将在此按时间线生成可回档快照。
          </div>
        ) : (
          <div className="relative space-y-3 border-l border-slate-200 pl-4">
            {sortedEntries.map((item) => {
              const meta = ACTION_META[item.action] ?? {
                label: item.action,
                badgeClass: 'border-slate-200 bg-slate-100 text-slate-700',
                dotClass: 'bg-slate-400',
              };
              const isLatest = item.version === latestVersion;
              const isConfirming = confirmVersion === item.version;

              return (
                <div
                  key={item.version}
                  className={`relative rounded-lg border p-2.5 text-xs transition-colors ${
                    isLatest
                      ? 'border-blue-200 bg-blue-50/35'
                      : isConfirming
                        ? 'border-amber-300 bg-amber-50/40'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute top-3.5 -left-[21px] h-2.5 w-2.5 rounded-full ring-4 ring-white ${meta.dotClass}`}
                  />

                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-bold text-slate-900">v{item.version}</span>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeClass}`}>
                        {meta.label}
                      </span>
                      {isLatest && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                          当前线上
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-slate-400">
                      {formatHistoryTime(item.ts)}
                    </span>
                  </div>

                  <p className="mt-1.5 break-words text-xs leading-relaxed text-slate-700">
                    {item.summary}
                  </p>

                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span className="truncate font-mono text-[10px]">操作者：{item.actor || 'unknown'}</span>
                    {!isLatest && !isConfirming && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => setConfirmVersion(item.version)}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        回档至此版本
                      </button>
                    )}
                  </div>

                  {isConfirming && (
                    <div className="mt-2.5 space-y-2 rounded-md border border-amber-200 bg-white p-2.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-900">
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                        确认将公共画布恢复至 v{item.version}
                      </div>
                      <input
                        type="password"
                        autoFocus
                        value={saveKey}
                        onChange={(e) => onChangeSaveKey(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleConfirmRollback(item.version);
                        }}
                        placeholder="输入管理员保存密钥 X-Blueprint-Save-Key"
                        className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px] text-slate-900 outline-none focus:border-amber-600"
                      />
                      {error && (
                        <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
                          {error}
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => setConfirmVersion(null)}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => void handleConfirmRollback(item.version)}
                          className="inline-flex items-center gap-1 rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {submitting ? '回档中…' : `确认回档 v${item.version}`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
