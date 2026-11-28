/**
 * @file PiAgentBlock.tsx
 * @description Atlas 画布上的 Pi Agent 摘要/抽象卡片（v111）：
 * - 画布职责定位为「多会话编排 + 状态摘要 + 停止条件设置」，不把厚重的完整对话流硬塞进小卡片；
 * - 点击右上角「会话页 ↗」即可跳转到 pi-runner 托管的独立单会话 Harness HTML 页面（`/pi/ui/:room/:nodeId`），
 *   查看该会话完整历史对话、思考链、工具日志、会话树并享有全部控制权（同源自动共享 sessionStorage 中的 PI_ADMIN_KEY）。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Download,
  ExternalLink,
  FileCode2,
  KeyRound,
  Loader2,
  Play,
  Plug,
  Send,
  Settings2,
  Shield,
  Square,
  Wrench,
} from 'lucide-react';
import { extractRoomPathFromBrowserLocation } from '../core/roomPath';
import { subscribePiMux } from '../core/piMuxStream';

const SESSION_ADMIN_KEY_STORAGE = 'atlas-pi-admin-key';
const SESSION_LLM_KEY_STORAGE = 'atlas-pi-llm-key';
const SESSION_LLM_ENV_STORAGE = 'atlas-pi-llm-env';
const KEY_SYNC_EVENT = 'atlas-pi-key-sync';

export interface PiAgentBlockProps {
  nodeId: string;
  baseUrl?: string;
  publicEnabled?: boolean;
  allowedInputPorts?: string[];
  provider?: string;
  model?: string;
  upstreamInput?: string;
  lastStatus?: string;
  lastOutput?: string;
  lastUpdatedAt?: string;
  onChangeBaseUrl: (next: string) => void;
  onRunResult: (result: {
    status: string;
    output: string;
    updatedAt: string;
    error: string;
  }) => void;
}

interface PiHealthInfo {
  ok: boolean;
  piInstalled: boolean;
  piVersion: string | null;
  piInstallHint: string;
  elyfnInstallPath: string;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function encodeRoomForUrl(room: string): string {
  return room
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function getCurrentRoomPath(): string {
  if (typeof window === 'undefined') return 'atlas-main';
  return extractRoomPathFromBrowserLocation(window.location.pathname, '/', window.location.search);
}

function readSessionValue(key: string, fallback = ''): string {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.sessionStorage.setItem(key, value);
    } else {
      window.sessionStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent(KEY_SYNC_EVENT));
  } catch {
    // ignore storage errors
  }
}

function extractTextDelta(ev: Record<string, unknown>): string {
  const nested = ev.assistantMessageEvent as Record<string, unknown> | undefined;
  if (ev.type === 'message_update' && nested?.type === 'text_delta' && typeof nested.delta === 'string') {
    return nested.delta;
  }
  if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
    return ev.delta;
  }
  return '';
}

function buildAbstractPreview(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-4).join('\n');
  return tail.length > 260 ? `…${tail.slice(-260)}` : tail;
}

function PiAgentBlockInner({
  nodeId,
  baseUrl = '',
  publicEnabled = false,
  allowedInputPorts = ['prompt'],
  provider = '',
  model = '',
  upstreamInput = '',
  lastStatus = '',
  lastOutput = '',
  lastUpdatedAt = '',
  onChangeBaseUrl,
  onRunResult,
}: PiAgentBlockProps) {
  const ports = useMemo(
    () => (Array.isArray(allowedInputPorts) && allowedInputPorts.length > 0 ? allowedInputPorts : ['prompt']),
    [allowedInputPorts]
  );

  const [mode, setMode] = useState<'public' | 'admin'>(publicEnabled ? 'public' : 'admin');
  const [baseDraft, setBaseDraft] = useState(baseUrl);
  const [adminKey, setAdminKey] = useState(() => readSessionValue(SESSION_ADMIN_KEY_STORAGE, ''));
  const [llmApiKey, setLlmApiKey] = useState(() => readSessionValue(SESSION_LLM_KEY_STORAGE, ''));
  const [llmApiKeyEnv, setLlmApiKeyEnv] = useState(() =>
    readSessionValue(SESSION_LLM_ENV_STORAGE, 'DEEPSEEK_API_KEY')
  );
  const [showConfig, setShowConfig] = useState(false);

  // Stop conditions (canvas sets graph + stop conditions; full session lives in /pi/ui/...)
  const [maxTurns, setMaxTurns] = useState('');
  const [stopRegex, setStopRegex] = useState('');
  const [maxDurationSec, setMaxDurationSec] = useState('');
  const [autoApproveUi, setAutoApproveUi] = useState(true);
  const [autoRunOnUpstream, setAutoRunOnUpstream] = useState(false);

  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of ports) init[p] = '';
    return init;
  });
  const [quickPrompt, setQuickPrompt] = useState('');

  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState(lastStatus || 'idle');
  const [fullOutput, setFullOutput] = useState(lastOutput || '');
  const [toolCount, setToolCount] = useState(0);
  const [modifiedFiles, setModifiedFiles] = useState<string[]>([]);
  const [stopNotice, setStopNotice] = useState('');
  const [errorText, setErrorText] = useState('');
  const [atlasMcpInjected, setAtlasMcpInjected] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [health, setHealth] = useState<PiHealthInfo | null>(null);
  const [installingPi, setInstallingPi] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const muxUnsubRef = useRef<(() => void) | null>(null);
  const outputRef = useRef(fullOutput);
  outputRef.current = fullOutput;
  const lastUpstreamRef = useRef(upstreamInput);

  useEffect(() => {
    setBaseDraft(baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    const onSync = () => {
      setAdminKey(readSessionValue(SESSION_ADMIN_KEY_STORAGE, ''));
      setLlmApiKey(readSessionValue(SESSION_LLM_KEY_STORAGE, ''));
      setLlmApiKeyEnv(readSessionValue(SESSION_LLM_ENV_STORAGE, 'DEEPSEEK_API_KEY'));
    };
    window.addEventListener(KEY_SYNC_EVENT, onSync);
    return () => window.removeEventListener(KEY_SYNC_EVENT, onSync);
  }, []);

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
      muxUnsubRef.current?.();
      muxUnsubRef.current = null;
    };
  }, []);

  const prefix = normalizeBaseUrl(baseDraft);
  const roomPath = getCurrentRoomPath();
  const encodedRoom = encodeRoomForUrl(roomPath);
  const encodedNode = encodeURIComponent(nodeId);
  const sessionTicketUrl = `${prefix}/pi/ui/${encodedRoom}/${encodedNode}`;
  const editorBaseUrl = `${prefix}/pi/editor/${encodedRoom}/${encodedNode}`;

  const probeHealth = useCallback(async () => {
    try {
      const resp = await fetch(`${prefix}/pi/health`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && typeof data === 'object') {
        setHealth({
          ok: Boolean(data.ok),
          piInstalled: data.piInstalled !== false,
          piVersion: typeof data.piVersion === 'string' ? data.piVersion : null,
          piInstallHint: typeof data.piInstallHint === 'string' ? data.piInstallHint : '',
          elyfnInstallPath:
            typeof data.elyfnInstallPath === 'string' ? data.elyfnInstallPath : '/setup/install-pi?async=1',
        });
      }
    } catch {
      // ignore offline probe
    }
  }, [prefix]);

  useEffect(() => {
    void probeHealth();
  }, [probeHealth]);

  const commitResult = useCallback(
    (status: string, output: string, error = '') => {
      const updatedAt = new Date().toTimeString().slice(0, 8);
      setStatusText(status);
      setErrorText(error);
      onRunResult({ status, output, updatedAt, error });
    },
    [onRunResult]
  );

  const handleInstallPiViaElyfn = useCallback(async () => {
    if (installingPi) return;
    setInstallingPi(true);
    setErrorText('');
    setStopNotice('正在调用 elyfn 安装宿主机 Pi Agent…');
    try {
      const targetPath = health?.elyfnInstallPath || '/setup/install-pi?async=1';
      const resp = await fetch(`${prefix}${targetPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: '@earendil-works/pi-coding-agent' }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setErrorText(`elyfn 安装返回 HTTP ${resp.status}，请检查 ${targetPath.split('?')[0]} 函数或宿主机手动安装`);
        setStopNotice('');
      } else {
        setStopNotice(data.jobId ? `已触发 elyfn 安装 (${data.jobId})` : '已触发 elyfn 安装任务');
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setStopNotice('');
    } finally {
      setInstallingPi(false);
    }
  }, [health?.elyfnInstallPath, installingPi, prefix]);

  const applyPiEvent = useCallback(
    (parsed: Record<string, unknown>) => {
      const delta = extractTextDelta(parsed);
      if (delta) {
        setFullOutput((prev) => {
          const next = prev + delta;
          outputRef.current = next;
          return next;
        });
      }
      if (parsed.type === 'tool_execution_start') {
        setToolCount((c) => c + 1);
      } else if (parsed.type === 'workspace_files_changed' && Array.isArray(parsed.files)) {
        setModifiedFiles(parsed.files.map((x) => String(x)).filter(Boolean).slice(-6));
      } else if (parsed.type === 'stop_condition_triggered') {
        setStopNotice(`停止条件命中：${String(parsed.reason || '')}`);
      } else if (parsed.type === 'agent_settled') {
        setRunning(false);
        commitResult('idle', outputRef.current, '');
      }
    },
    [commitResult]
  );

  const ensureAdminStream = useCallback(
    (key: string) => {
      if (muxUnsubRef.current) return;
      muxUnsubRef.current = subscribePiMux(prefix, key, roomPath, nodeId, (env) => {
        if (env.eventName === 'pi_event') {
          applyPiEvent(env.payload);
        } else if (env.eventName === 'session_exit') {
          setRunning(false);
          setStatusText('exited');
        }
      });
    },
    [applyPiEvent, nodeId, prefix, roomPath]
  );

  // Auto-subscribe to shared multiplexed SSE stream whenever adminKey is present
  useEffect(() => {
    if (mode !== 'admin' || !adminKey.trim()) {
      muxUnsubRef.current?.();
      muxUnsubRef.current = null;
      return;
    }
    ensureAdminStream(adminKey.trim());
    return () => {
      muxUnsubRef.current?.();
      muxUnsubRef.current = null;
    };
  }, [adminKey, ensureAdminStream, mode]);

  const handlePublicRun = useCallback(
    async (overrideInputs?: Record<string, string>) => {
      if (running) return;
      esRef.current?.close();
      esRef.current = null;
      setRunning(true);
      setErrorText('');
      setStopNotice('');
      setFullOutput('');
      setToolCount(0);
      setStatusText('running');

      const src = overrideInputs || inputs;
      const payloadInputs: Record<string, string> = {};
      for (const p of ports) {
        if (src[p] !== undefined) payloadInputs[p] = src[p];
      }

      try {
        const resp = await fetch(`${prefix}/pi/public/${encodedRoom}/${encodedNode}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: payloadInputs }),
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        if (!resp.ok || !data.ok) {
          setRunning(false);
          commitResult('failed', '', String(data.error || `HTTP ${resp.status}`));
          return;
        }
        const es = new EventSource(`${prefix}${data.streamUrl || `/pi/runs/${data.runId}/stream`}`);
        esRef.current = es;
        es.addEventListener('pi_event', (ev) => {
          try {
            applyPiEvent(JSON.parse((ev as MessageEvent).data) as Record<string, unknown>);
          } catch {
            // ignore
          }
        });
        es.addEventListener('done', (ev) => {
          es.close();
          esRef.current = null;
          setRunning(false);
          try {
            const parsed = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
            const finalOut = String(parsed.outputText ?? outputRef.current ?? '');
            setFullOutput(finalOut);
            commitResult(String(parsed.status ?? 'completed'), finalOut, String(parsed.error ?? ''));
          } catch {
            commitResult('completed', outputRef.current, '');
          }
        });
        es.onerror = () => {
          es.close();
          esRef.current = null;
          setRunning(false);
          commitResult('disconnected', outputRef.current, 'SSE 连接中断');
        };
      } catch (err) {
        setRunning(false);
        commitResult('failed', '', err instanceof Error ? err.message : String(err));
      }
    },
    [applyPiEvent, commitResult, encodedNode, encodedRoom, inputs, ports, prefix, running]
  );

  const handleAdminRun = useCallback(
    async (overridePrompt?: string) => {
      const msg = (overridePrompt ?? quickPrompt).trim();
      if (!msg) return;
      const key = adminKey.trim();
      if (!key) {
        setErrorText('请先点击右上角设置填写 PI_ADMIN_KEY');
        setShowConfig(true);
        return;
      }
      setRunning(true);
      setErrorText('');
      setStopNotice('');
      setFullOutput('');
      setToolCount(0);
      setStatusText('running');

      ensureAdminStream(key);

      const stopCondition: Record<string, unknown> = { autoApproveUi };
      if (Number(maxTurns) > 0) stopCondition.maxTurns = Number(maxTurns);
      if (stopRegex.trim()) stopCondition.stopRegex = stopRegex.trim();
      if (Number(maxDurationSec) > 0) stopCondition.maxDurationMs = Number(maxDurationSec) * 1000;

      try {
        const resp = await fetch(`${prefix}/pi/admin/${encodedRoom}/${encodedNode}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pi-Admin-Key': key },
          body: JSON.stringify({
            message: msg,
            provider,
            model,
            stopCondition,
            llmApiKey: llmApiKey.trim() || undefined,
            llmApiKeyEnv: llmApiKey.trim() ? llmApiKeyEnv : undefined,
          }),
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        if (!resp.ok || !data.ok) {
          setRunning(false);
          commitResult('failed', outputRef.current, String(data.error || `HTTP ${resp.status}`));
          return;
        }
        if (typeof data.atlasMcpInjected === 'boolean') setAtlasMcpInjected(data.atlasMcpInjected);
        if (!overridePrompt) setQuickPrompt('');
        if (data.status === 'idle') {
          setRunning(false);
          commitResult('idle', outputRef.current, '');
        }
      } catch (err) {
        setRunning(false);
        commitResult('failed', outputRef.current, err instanceof Error ? err.message : String(err));
      }
    },
    [
      adminKey,
      autoApproveUi,
      commitResult,
      encodedNode,
      encodedRoom,
      ensureAdminStream,
      llmApiKey,
      llmApiKeyEnv,
      maxDurationSec,
      maxTurns,
      model,
      prefix,
      provider,
      quickPrompt,
      stopRegex,
    ]
  );

  useEffect(() => {
    if (upstreamInput === lastUpstreamRef.current) return;
    lastUpstreamRef.current = upstreamInput;
    if (!autoRunOnUpstream || !upstreamInput.trim() || running) return;
    if (mode === 'admin' && adminKey.trim()) {
      void handleAdminRun(upstreamInput);
    } else if (mode === 'public') {
      const nextInputs = { ...inputs, [ports[0]]: upstreamInput };
      setInputs(nextInputs);
      void handlePublicRun(nextInputs);
    }
  }, [adminKey, autoRunOnUpstream, handleAdminRun, handlePublicRun, inputs, mode, ports, running, upstreamInput]);

  const handleToggleMcp = useCallback(async () => {
    const key = adminKey.trim();
    if (!key) {
      setErrorText('请先填写 PI_ADMIN_KEY');
      setShowConfig(true);
      return;
    }
    if (mcpBusy) return;
    setMcpBusy(true);
    try {
      const nextEnable = !atlasMcpInjected;
      const resp = await fetch(`${prefix}/pi/admin/${encodedRoom}/${encodedNode}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Admin-Key': key },
        body: JSON.stringify({ enable: nextEnable, restart: true }),
      });
      const data = await resp.json().catch(() => ({ ok: false }));
      if (resp.ok && data.ok) {
        setAtlasMcpInjected(Boolean(data.atlasMcpInjected));
        adminStreamAbortRef.current?.abort();
        adminStreamAbortRef.current = null;
      } else {
        setErrorText(String(data.error || `HTTP ${resp.status}`));
      }
    } finally {
      setMcpBusy(false);
    }
  }, [adminKey, atlasMcpInjected, encodedNode, encodedRoom, mcpBusy, prefix]);

  const handleAbort = useCallback(async () => {
    const key = adminKey.trim();
    if (!key) return;
    await fetch(`${prefix}/pi/admin/${encodedRoom}/${encodedNode}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Admin-Key': key },
      body: '{}',
    }).catch(() => {});
    setRunning(false);
    commitResult('aborted', outputRef.current, '');
  }, [adminKey, commitResult, encodedNode, encodedRoom, prefix]);

  const stopSummary = useMemo(() => {
    const parts: string[] = [];
    if (Number(maxTurns) > 0) parts.push(`轮数≤${maxTurns}`);
    if (Number(maxDurationSec) > 0) parts.push(`${maxDurationSec}s`);
    if (stopRegex.trim()) parts.push(`/${stopRegex.trim()}/`);
    parts.push(autoApproveUi ? '无人值守' : '人工审批');
    return parts.join(' · ');
  }, [autoApproveUi, maxDurationSec, maxTurns, stopRegex]);

  const abstractPreview = useMemo(() => buildAbstractPreview(fullOutput), [fullOutput]);

  return (
    <div
      className="nodrag nopan flex w-full flex-col gap-2 text-xs text-slate-800 dark:text-slate-100"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 顶栏：模式切换 + 状态 + 打开独立单会话页面 */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5">
          <button
            type="button"
            onClick={() => setMode('public')}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              mode === 'public'
                ? 'bg-slate-900 dark:bg-blue-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            <Shield className="h-3 w-3" />
            访客
          </button>
          <button
            type="button"
            onClick={() => setMode('admin')}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              mode === 'admin'
                ? 'bg-slate-900 dark:bg-blue-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            <KeyRound className="h-3 w-3" />
            管理员
          </button>
        </div>

        <div className="flex items-center gap-1">
          {mode === 'admin' && (
            <button
              type="button"
              disabled={mcpBusy}
              onClick={() => void handleToggleMcp()}
              title="手动向此会话注入/移除 Atlas MCP"
              className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                atlasMcpInjected
                  ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Plug className="h-2.5 w-2.5" />
              {atlasMcpInjected ? 'MCP' : '+MCP'}
            </button>
          )}
          <a
            href={sessionTicketUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="打开 pi-runner 独立单会话 Harness 页面（查看全部对话并享有完整控制）"
            className="inline-flex items-center gap-0.5 rounded border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60"
          >
            会话页
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
          <a
            href={`${editorBaseUrl}?tab=diff`}
            target="_blank"
            rel="noopener noreferrer"
            title="新标签打开独立文件编辑器与 Git Diff 站点"
            className="inline-flex items-center gap-0.5 rounded border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/60"
          >
            <FileCode2 className="h-2.5 w-2.5" />
            Diff
          </a>
          <button
            type="button"
            onClick={() => setShowConfig((v) => !v)}
            title="设置 API Key 与停止条件"
            className="rounded border border-slate-200 dark:border-slate-700 p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Settings2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 宿主机未装 Pi 提示 */}
      {health && !health.piInstalled && (
        <div className="flex items-center justify-between gap-1.5 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/50 px-2 py-1 text-[10px] text-amber-900 dark:text-amber-200">
          <span className="inline-flex items-center gap-1 truncate">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            宿主机未装 Pi Agent
          </span>
          <button
            type="button"
            disabled={installingPi}
            onClick={() => void handleInstallPiViaElyfn()}
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-600 px-1.5 py-0.5 font-semibold text-white hover:bg-amber-700"
          >
            {installingPi ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Download className="h-2.5 w-2.5" />}
            elyfn 安装
          </button>
        </div>
      )}

      {/* 上游画布连线摘要条 */}
      {upstreamInput.trim() && (
        <div className="flex items-center justify-between gap-1 rounded border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 px-2 py-1 text-[10px] text-blue-800 dark:text-blue-200">
          <span className="truncate">上游: {upstreamInput.slice(0, 48)}</span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                if (mode === 'admin') setQuickPrompt(upstreamInput);
                else setInputs((prev) => ({ ...prev, [ports[0]]: upstreamInput }));
              }}
              className="rounded bg-blue-600 px-1.5 py-0.5 text-white hover:bg-blue-700"
            >
              填入
            </button>
            <label className="inline-flex cursor-pointer items-center gap-0.5">
              <input
                type="checkbox"
                checked={autoRunOnUpstream}
                onChange={(e) => setAutoRunOnUpstream(e.target.checked)}
              />
              自动
            </label>
          </div>
        </div>
      )}

      {/* 折叠配置：API Key（sessionStorage 共享）与停止条件 */}
      {showConfig && (
        <div className="space-y-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/90 dark:bg-slate-900/80 p-2 text-[10px]">
          <input
            type="text"
            value={baseDraft}
            onChange={(e) => setBaseDraft(e.target.value)}
            onBlur={() => onChangeBaseUrl(baseDraft)}
            placeholder="pi-runner 地址（留空默认同源 /pi/*）"
            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 font-mono outline-none"
          />
          {mode === 'admin' && (
            <>
              <input
                type="password"
                value={adminKey}
                onChange={(e) => {
                  setAdminKey(e.target.value);
                  writeSessionValue(SESSION_ADMIN_KEY_STORAGE, e.target.value);
                }}
                placeholder="PI_ADMIN_KEY（仅存 sessionStorage，与会话页共享）"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 font-mono outline-none"
              />
              <div className="grid grid-cols-2 gap-1">
                <select
                  value={llmApiKeyEnv}
                  onChange={(e) => {
                    setLlmApiKeyEnv(e.target.value);
                    writeSessionValue(SESSION_LLM_ENV_STORAGE, e.target.value);
                  }}
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-1 py-1 font-mono outline-none"
                >
                  <option value="DEEPSEEK_API_KEY">DEEPSEEK_API_KEY</option>
                  <option value="OPENAI_API_KEY">OPENAI_API_KEY</option>
                  <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
                  <option value="GEMINI_API_KEY">GEMINI_API_KEY</option>
                  <option value="OPENROUTER_API_KEY">OPENROUTER_API_KEY</option>
                </select>
                <input
                  type="password"
                  value={llmApiKey}
                  onChange={(e) => {
                    setLlmApiKey(e.target.value);
                    writeSessionValue(SESSION_LLM_KEY_STORAGE, e.target.value);
                  }}
                  placeholder="可选 LLM Key"
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-1.5 py-1 font-mono outline-none"
                />
              </div>
              <div className="grid grid-cols-3 gap-1">
                <input
                  type="number"
                  min={0}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  placeholder="最大轮数"
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-1.5 py-1 outline-none"
                />
                <input
                  type="number"
                  min={0}
                  value={maxDurationSec}
                  onChange={(e) => setMaxDurationSec(e.target.value)}
                  placeholder="超时(秒)"
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-1.5 py-1 outline-none"
                />
                <input
                  type="text"
                  value={stopRegex}
                  onChange={(e) => setStopRegex(e.target.value)}
                  placeholder="停止正则"
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-1.5 py-1 font-mono outline-none"
                />
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1 text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={autoApproveUi}
                  onChange={(e) => setAutoApproveUi(e.target.checked)}
                />
                无人值守自动放行
              </label>
            </>
          )}
        </div>
      )}

      {/* 极简触发区 */}
      {mode === 'public' ? (
        <div className="space-y-1">
          {ports.map((p) => (
            <input
              key={p}
              type="text"
              value={inputs[p] ?? ''}
              onChange={(e) => setInputs((prev) => ({ ...prev, [p]: e.target.value }))}
              placeholder={`${p}…`}
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs outline-none"
            />
          ))}
          <button
            type="button"
            disabled={running}
            onClick={() => void handlePublicRun()}
            className="inline-flex w-full items-center justify-center gap-1 rounded bg-slate-900 dark:bg-blue-600 py-1 text-xs font-semibold text-white hover:bg-slate-700 dark:hover:bg-blue-500 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? '运行中…' : '运行'}
          </button>
        </div>
      ) : (
        <div className="flex gap-1">
          <input
            type="text"
            value={quickPrompt}
            onChange={(e) => setQuickPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAdminRun();
              }
            }}
            placeholder="快速下发任务（回车启动）…"
            className="min-w-0 flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          />
          {running ? (
            <button
              type="button"
              onClick={() => void handleAbort()}
              className="inline-flex shrink-0 items-center rounded bg-rose-600 px-2 text-white hover:bg-rose-700"
              title="中断"
            >
              <Square className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleAdminRun()}
              className="inline-flex shrink-0 items-center rounded bg-slate-900 dark:bg-blue-600 px-2 text-white hover:bg-slate-700 dark:hover:bg-blue-500"
              title="启动任务"
            >
              <Send className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* 状态摘要条（状态 + 停止条件 + 工具计数） */}
      <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-500 dark:text-slate-400">
        <span className="font-mono">
          {statusText}
          {lastUpdatedAt ? ` · ${lastUpdatedAt}` : ''}
        </span>
        <div className="flex items-center gap-1.5">
          {toolCount > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono">
              <Wrench className="h-2.5 w-2.5" />
              {toolCount}
            </span>
          )}
          {mode === 'admin' && <span className="truncate max-w-[150px]">{stopSummary}</span>}
        </div>
      </div>

      {stopNotice && (
        <div className="rounded bg-blue-50 dark:bg-blue-950/50 px-2 py-1 text-[10px] text-blue-700 dark:text-blue-300">
          {stopNotice}
        </div>
      )}
      {errorText && (
        <div className="rounded border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/50 px-2 py-1 text-[10px] text-rose-700 dark:text-rose-300">
          {errorText}
        </div>
      )}

      {/* 文件修改提示条（仅提示 + 新标签直达独立编辑器 / Diff） */}
      {modifiedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 rounded border border-violet-200 dark:border-violet-800 bg-violet-50/80 dark:bg-violet-950/40 px-2 py-1 text-[10px] text-violet-800 dark:text-violet-200">
          <FileCode2 className="h-3 w-3 shrink-0" />
          <span>已改 {modifiedFiles.length} 文件:</span>
          {modifiedFiles.slice(-3).map((f) => (
            <a
              key={f}
              href={`${editorBaseUrl}?file=${encodeURIComponent(f)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-violet-600 dark:hover:text-violet-100 font-mono"
            >
              {f.split('/').pop()}
            </a>
          ))}
          <a
            href={`${editorBaseUrl}?tab=diff`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto font-semibold underline"
          >
            查看 Diff ↗
          </a>
        </div>
      )}

      {/* 精简摘要预览（完整对话与全部控制请点右上角「会话页 ↗」） */}
      <div className="min-h-[44px] max-h-24 overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-950/80 px-2 py-1.5 font-mono text-[11px] leading-snug text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
        {abstractPreview || (
          <span className="inline-flex items-center gap-1 text-slate-400">
            <Bot className="h-3 w-3" />
            摘要视图 · 点击「会话页 ↗」进入完整控制
          </span>
        )}
      </div>
    </div>
  );
}

export const PiAgentBlock = memo(PiAgentBlockInner);
