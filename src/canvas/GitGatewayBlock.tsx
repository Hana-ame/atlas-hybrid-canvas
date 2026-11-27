/**
 * @file GitGatewayBlock.tsx
 * @description git-gateway 仓库看板控件：
 * - 自动从 `GET <baseUrl>/repos` 拉取白名单仓库与别名目录；
 * - 支持定时自动刷新仓库目录、Open PR 与 TODO（离屏与后台页签自动休眠）；
 * - 支持一键切换仓库，实时浏览 Open PR 列表、按 PR 查询 CI 状态与失败日志，以及查看仓库 TODO；
 * - 将仓库摘要同步写回节点 vars，可供下游连线节点消费。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Clock, ExternalLink, FileText, GitPullRequest, Loader2, RefreshCw } from 'lucide-react';

export interface GitGatewayRepoItem {
  id: string;
  owner: string;
  repo: string;
  path: string;
  aliases?: string[];
}

interface GitPrItem {
  number: number;
  title: string;
  state: string;
  head_branch?: string;
  base_branch?: string;
  html_url?: string;
}

export interface GitGatewayBlockProps {
  baseUrl?: string;
  selectedRepo?: string;
  activeTab?: 'prs' | 'todo';
  autoRefreshSec?: number;
  mediaActive?: boolean;
  onChangeBaseUrl: (next: string) => void;
  onChangeSelectedRepo: (next: string) => void;
  onChangeActiveTab: (next: 'prs' | 'todo') => void;
  onChangeAutoRefreshSec?: (nextSec: number) => void;
  onSyncState: (patch: {
    gitRepo: string;
    gitOpenPrCount: number;
    gitTodoPreview: string;
    gitUpdatedAt: string;
  }) => void;
}

const REFRESH_OPTIONS = [
  { label: '关', value: 0 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: '5m', value: 300 },
];

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function normalizeRefreshSec(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(5, Math.min(3600, Math.floor(n)));
}

function GitGatewayBlockInner({
  baseUrl = '',
  selectedRepo = '',
  activeTab = 'prs',
  autoRefreshSec = 0,
  mediaActive = true,
  onChangeBaseUrl,
  onChangeSelectedRepo,
  onChangeActiveTab,
  onChangeAutoRefreshSec,
  onSyncState,
}: GitGatewayBlockProps) {
  const [baseDraft, setBaseDraft] = useState(baseUrl);
  const [repoDraft, setRepoDraft] = useState(selectedRepo);
  const [tab, setTab] = useState<'prs' | 'todo'>(activeTab === 'todo' ? 'todo' : 'prs');
  const [refreshSec, setRefreshSec] = useState(() => normalizeRefreshSec(autoRefreshSec));
  const [showBaseInput, setShowBaseInput] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  );

  const [repos, setRepos] = useState<GitGatewayRepoItem[]>([]);
  const [prs, setPrs] = useState<GitPrItem[]>([]);
  const [todoText, setTodoText] = useState('');
  const [ciSummary, setCiSummary] = useState<Record<number, string>>({});
  const [ciLogs, setCiLogs] = useState<string>('');

  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    setBaseDraft(baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    setRepoDraft(selectedRepo);
  }, [selectedRepo]);

  useEffect(() => {
    setTab(activeTab === 'todo' ? 'todo' : 'prs');
  }, [activeTab]);

  useEffect(() => {
    setRefreshSec(normalizeRefreshSec(autoRefreshSec));
  }, [autoRefreshSec]);

  const fetchRepoDetail = useCallback(
    async (targetRepo: string) => {
      const cleaned = targetRepo.trim().replace(/^\/+|\/+$/g, '');
      if (!cleaned) return;
      setLoadingDetail(true);
      setErrorMsg('');
      setCiLogs('');
      const prefix = normalizeBaseUrl(baseDraft);
      try {
        const [prsRes, todoRes] = await Promise.all([
          fetch(`${prefix}/${cleaned}/prs?state=open&limit=20`, {
            headers: { Accept: 'application/json' },
          }),
          fetch(`${prefix}/${cleaned}/todo?format=json`, {
            headers: { Accept: 'application/json' },
          }),
        ]);

        let nextPrs: GitPrItem[] = [];
        let nextTodo = '';
        if (prsRes.ok) {
          const prData = (await prsRes.json().catch(() => ({}))) as Record<string, unknown>;
          if (Array.isArray(prData.prs)) {
            nextPrs = prData.prs as GitPrItem[];
          }
        }
        if (todoRes.ok) {
          const tdData = (await todoRes.json().catch(() => ({}))) as Record<string, unknown>;
          nextTodo = String(tdData.content ?? tdData.todo ?? '');
        }
        if (!mountedRef.current) return;
        setPrs(nextPrs);
        setTodoText(nextTodo);
        if (!prsRes.ok && !todoRes.ok) {
          setErrorMsg(`加载仓库失败（PR:${prsRes.status} / TODO:${todoRes.status}）`);
        }
        onSyncState({
          gitRepo: cleaned,
          gitOpenPrCount: nextPrs.length,
          gitTodoPreview: nextTodo.slice(0, 240),
          gitUpdatedAt: new Date().toLocaleTimeString(),
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setErrorMsg(`请求异常：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (mountedRef.current) setLoadingDetail(false);
      }
    },
    [baseDraft, onSyncState]
  );

  const fetchRepos = useCallback(async () => {
    setLoadingRepos(true);
    setErrorMsg('');
    try {
      const prefix = normalizeBaseUrl(baseDraft);
      const res = await fetch(`${prefix}/repos`, { headers: { Accept: 'application/json' } });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErrorMsg(`拉取仓库目录失败：HTTP ${res.status}`);
        return;
      }
      const list = Array.isArray(data.repos) ? (data.repos as GitGatewayRepoItem[]) : [];
      setRepos(list);
      const current = repoDraft.trim();
      if (!current && list.length > 0) {
        const firstPath = list[0].path || list[0].id;
        setRepoDraft(firstPath);
        onChangeSelectedRepo(firstPath);
        void fetchRepoDetail(firstPath);
      } else if (current) {
        void fetchRepoDetail(current);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(`目录拉取异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mountedRef.current) setLoadingRepos(false);
    }
  }, [baseDraft, fetchRepoDetail, onChangeSelectedRepo, repoDraft]);

  useEffect(() => {
    if (!mediaActive) return;
    void fetchRepos();
  }, [mediaActive, fetchRepos]);

  // 定时自动刷新仓库目录、PR 与 TODO（离屏或后台页签自动休眠）
  useEffect(() => {
    if (!mediaActive || !pageVisible || refreshSec <= 0) return;
    const timer = setInterval(() => {
      void fetchRepos();
    }, refreshSec * 1000);
    return () => clearInterval(timer);
  }, [mediaActive, pageVisible, refreshSec, fetchRepos]);

  const inspectPrCi = useCallback(
    async (prNumber: number) => {
      const cleaned = repoDraft.trim().replace(/^\/+|\/+$/g, '');
      if (!cleaned) return;
      const prefix = normalizeBaseUrl(baseDraft);
      setCiSummary((prev) => ({ ...prev, [prNumber]: '查询中…' }));
      try {
        const res = await fetch(`${prefix}/${cleaned}/prs/${prNumber}/ci`, {
          headers: { Accept: 'application/json' },
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!mountedRef.current) return;
        const status = String(data.status ?? (res.ok ? 'unknown' : `HTTP ${res.status}`));
        setCiSummary((prev) => ({ ...prev, [prNumber]: status }));
        if (status === 'failed') {
          const logRes = await fetch(`${prefix}/${cleaned}/prs/${prNumber}/logs?tail=60`);
          const text = await logRes.text();
          if (mountedRef.current) setCiLogs(text.slice(0, 3000));
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setCiSummary((prev) => ({
          ...prev,
          [prNumber]: err instanceof Error ? err.message : 'err',
        }));
      }
    },
    [baseDraft, repoDraft]
  );

  return (
    <div
      className="nodrag nopan nowheel flex w-full flex-col gap-2 rounded-md border border-emerald-200 bg-emerald-50/40 p-2 text-xs text-slate-800"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 仓库选择 + 定时刷新 + 立即刷新 */}
      <div className="flex items-center gap-1">
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
        <select
          value={repos.some((r) => (r.path || r.id) === repoDraft) ? repoDraft : ''}
          onChange={(e) => {
            const v = e.target.value;
            setRepoDraft(v);
            onChangeSelectedRepo(v);
            if (v) void fetchRepoDetail(v);
          }}
          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-500"
        >
          <option value="">
            {repos.length > 0 ? `选择仓库（共 ${repos.length} 个）…` : '未获取到仓库，可手动输入'}
          </option>
          {repos.map((r) => {
            const val = r.path || r.id;
            return (
              <option key={r.id} value={val}>
                {r.id}
              </option>
            );
          })}
        </select>
        <div
          title="定时自动刷新看板间隔（离屏/后台自动暂停）"
          className={`inline-flex items-center rounded border px-1 py-0.5 text-[10px] ${
            refreshSec > 0 ? 'border-emerald-400 bg-emerald-100 text-emerald-800' : 'border-slate-300 bg-white text-slate-600'
          }`}
        >
          <Clock className="mr-0.5 h-3 w-3 shrink-0" />
          <select
            value={refreshSec}
            onChange={(e) => {
              const next = normalizeRefreshSec(e.target.value);
              setRefreshSec(next);
              onChangeAutoRefreshSec?.(next);
            }}
            className="bg-transparent text-[10px] outline-none"
          >
            {REFRESH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          title="立即刷新仓库目录与看板"
          disabled={loadingRepos || loadingDetail}
          onClick={() => void fetchRepos()}
          className="inline-flex items-center justify-center rounded border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingRepos || loadingDetail ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          title="自定义 git-gateway 基址"
          onClick={() => setShowBaseInput((v) => !v)}
          className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[10px] text-slate-600 hover:bg-slate-100"
        >
          基址
        </button>
      </div>

      {showBaseInput && (
        <div className="flex gap-1">
          <input
            type="text"
            value={baseDraft}
            placeholder="留空走当前同源，或填 https://git.example.com"
            onChange={(e) => setBaseDraft(e.target.value)}
            onBlur={() => onChangeBaseUrl(baseDraft.trim())}
            className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-emerald-500"
          />
          <input
            type="text"
            value={repoDraft}
            placeholder="owner/repo"
            onChange={(e) => setRepoDraft(e.target.value)}
            onBlur={() => {
              const v = repoDraft.trim();
              onChangeSelectedRepo(v);
              if (v) void fetchRepoDetail(v);
            }}
            className="w-32 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] outline-none focus:border-emerald-500"
          />
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setTab('prs');
            onChangeActiveTab('prs');
          }}
          className={`inline-flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
            tab === 'prs' ? 'bg-emerald-700 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
          }`}
        >
          <GitPullRequest className="h-3 w-3" />
          <span>PR / CI ({prs.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('todo');
            onChangeActiveTab('todo');
          }}
          className={`inline-flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
            tab === 'todo' ? 'bg-emerald-700 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
          }`}
        >
          <FileText className="h-3 w-3" />
          <span>TODO</span>
        </button>
      </div>

      {errorMsg && (
        <div className="rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">{errorMsg}</div>
      )}

      {loadingDetail ? (
        <div className="flex items-center justify-center gap-1 py-4 text-[11px] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>加载中…</span>
        </div>
      ) : tab === 'prs' ? (
        <div className="flex max-h-44 flex-col gap-1.5 overflow-auto">
          {prs.length === 0 ? (
            <div className="rounded bg-white px-2 py-3 text-center text-[11px] text-slate-400">
              当前无 Open PR
            </div>
          ) : (
            prs.map((pr) => (
              <div
                key={pr.number}
                className="flex flex-col gap-1 rounded border border-slate-200 bg-white p-1.5"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-medium text-slate-800">
                    #{pr.number} {pr.title}
                  </span>
                  {pr.html_url && (
                    <a
                      href={pr.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-emerald-700 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span className="truncate font-mono">
                    {pr.head_branch || ''} → {pr.base_branch || ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => void inspectPrCi(pr.number)}
                    className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-200"
                  >
                    {ciSummary[pr.number] ? `CI: ${ciSummary[pr.number]}` : '查 CI'}
                  </button>
                </div>
              </div>
            ))
          )}
          {ciLogs && (
            <pre className="max-h-28 overflow-auto rounded bg-slate-900 p-1.5 font-mono text-[10px] text-amber-200">
              {ciLogs}
            </pre>
          )}
        </div>
      ) : (
        <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-700">
          {todoText.trim() || '（暂无 TODO 内容）'}
        </pre>
      )}
    </div>
  );
}

export const GitGatewayBlock = memo(GitGatewayBlockInner);
