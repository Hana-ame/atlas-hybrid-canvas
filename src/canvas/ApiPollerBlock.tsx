/**
 * @file ApiPollerBlock.tsx
 * @description API 定时轮询抓取控件：
 * - 支持 URL / 方法(GET|POST) / 间隔(2–3600s) / JSON 路径提取 / Proxy 代理开关；
 * - 内置防并发竞态（AbortController + 递增 seq）、连续失败指数退避、后台页签/离屏自动休眠、卸载清理；
 * - 每次抓取结果同步写回节点 vars，可供下游连线控件通过 widgets.inputs() 实时消费。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Globe, Pause, Play, RefreshCw } from 'lucide-react';
import {
  computeBackoffDelayMs,
  extractJsonPath,
  formatPolledValue,
  isSafePollUrl,
  normalizePollIntervalSec,
  normalizePollMethod,
} from '../core/apiPoller';
import { proxyHeaders } from '../core/apiClient';

export interface ApiPollerBlockProps {
  url: string;
  method: 'GET' | 'POST';
  intervalSec: number;
  jsonPath: string;
  useProxy: boolean;
  enabled: boolean;
  lastValue?: string;
  lastStatus?: string;
  lastUpdatedAt?: string;
  mediaActive?: boolean;
  onChangeUrl: (nextUrl: string) => void;
  onChangeMethod: (nextMethod: 'GET' | 'POST') => void;
  onChangeInterval: (nextSec: number) => void;
  onChangeJsonPath: (nextPath: string) => void;
  onChangeUseProxy: (nextProxy: boolean) => void;
  onChangeEnabled: (nextEnabled: boolean) => void;
  onPollResult: (result: { value: string; status: string; updatedAt: string; error: string }) => void;
}

function ApiPollerBlockInner({
  url,
  method,
  intervalSec,
  jsonPath,
  useProxy,
  enabled,
  lastValue = '',
  lastStatus = '',
  lastUpdatedAt = '',
  mediaActive = true,
  onChangeUrl,
  onChangeMethod,
  onChangeInterval,
  onChangeJsonPath,
  onChangeUseProxy,
  onChangeEnabled,
  onPollResult,
}: ApiPollerBlockProps) {
  const safeInterval = normalizePollIntervalSec(intervalSec);
  const safeMethod = normalizePollMethod(method);

  const [urlDraft, setUrlDraft] = useState(url);
  const [intervalDraft, setIntervalDraft] = useState(String(safeInterval));
  const [pathDraft, setPathDraft] = useState(jsonPath);
  const [isFetching, setIsFetching] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [okCount, setOkCount] = useState(0);
  const [errCount, setErrCount] = useState(0);
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const [pageVisible, setPageVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  );

  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const consecutiveErrRef = useRef(0);
  const onPollResultRef = useRef(onPollResult);
  const lastValueRef = useRef(lastValue);
  const pathDraftRef = useRef(pathDraft);
  onPollResultRef.current = onPollResult;
  lastValueRef.current = lastValue;
  pathDraftRef.current = pathDraft;

  useEffect(() => {
    setUrlDraft(url);
  }, [url]);

  useEffect(() => {
    setIntervalDraft(String(safeInterval));
  }, [safeInterval]);

  useEffect(() => {
    setPathDraft(jsonPath);
  }, [jsonPath]);

  // 监听页签可见性：切后台自动暂停轮询，回前台自动继续
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 组件卸载时立刻中断请求并清理定时器
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const executePollOnce = useCallback(
    async (overrideUrl?: string) => {
      const targetUrl = (overrideUrl ?? url).trim();
      if (!isSafePollUrl(targetUrl)) {
        const msg = '仅支持 http/https 外链或同源 /api/ 路径（拒绝 javascript:/data:）';
        setErrorMsg(msg);
        onPollResultRef.current({
          value: lastValueRef.current,
          status: 'INVALID_URL',
          updatedAt: new Date().toLocaleTimeString(),
          error: msg,
        });
        return false;
      }

      // Single-flight：中断未完成的旧请求，递增 seq 防止乱序覆盖
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const mySeq = ++seqRef.current;

      setIsFetching(true);
      setErrorMsg('');

      try {
        const isLocalApi = targetUrl.startsWith('/api/');
        let statusText = '';
        let payload: unknown;

        if (!isLocalApi && useProxy) {
          const resp = await fetch('/api/proxy', {
            method: 'POST',
            headers: proxyHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ url: targetUrl, method: safeMethod }),
            signal: controller.signal,
          });
          const data = (await resp.json().catch(() => null)) as {
            ok?: boolean;
            status?: number;
            responseBody?: unknown;
            error?: string;
          } | null;

          if (!mountedRef.current || mySeq !== seqRef.current) return false;

          if (!resp.ok || !data?.ok) {
            throw new Error(data?.error || `代理请求失败 (HTTP ${data?.status ?? resp.status})`);
          }
          statusText = `HTTP ${data.status ?? resp.status}`;
          payload = data.responseBody;
        } else {
          const resp = await fetch(targetUrl, {
            method: safeMethod,
            headers: isLocalApi ? proxyHeaders() : undefined,
            signal: controller.signal,
          });
          if (!mountedRef.current || mySeq !== seqRef.current) return false;
          statusText = `HTTP ${resp.status}`;
          const rawText = await resp.text();
          if (!rawText) {
            payload = '';
          } else {
            try {
              payload = JSON.parse(rawText);
            } catch {
              payload = rawText;
            }
          }
          if (!resp.ok) {
            throw new Error(`接口返回 ${statusText}`);
          }
        }

        if (!mountedRef.current || mySeq !== seqRef.current) return false;

        const extracted = extractJsonPath(payload, pathDraftRef.current);
        const formatted = formatPolledValue(extracted);
        const nowStr = new Date().toLocaleTimeString();

        consecutiveErrRef.current = 0;
        setConsecutiveErrors(0);
        setOkCount((c) => c + 1);
        setErrorMsg('');
        onPollResultRef.current({ value: formatted, status: statusText, updatedAt: nowStr, error: '' });
        return true;
      } catch (err) {
        if (!mountedRef.current || mySeq !== seqRef.current) return false;
        if (err instanceof Error && err.name === 'AbortError') return false;
        const msg = err instanceof Error ? err.message : String(err);
        const nextErrs = consecutiveErrRef.current + 1;
        consecutiveErrRef.current = nextErrs;
        setConsecutiveErrors(nextErrs);
        setErrCount((c) => c + 1);
        setErrorMsg(msg);
        onPollResultRef.current({
          value: lastValueRef.current,
          status: 'ERROR',
          updatedAt: new Date().toLocaleTimeString(),
          error: msg,
        });
        return false;
      } finally {
        if (mountedRef.current && mySeq === seqRef.current) {
          setIsFetching(false);
        }
      }
    },
    [url, useProxy, safeMethod]
  );

  const executePollOnceRef = useRef(executePollOnce);
  executePollOnceRef.current = executePollOnce;

  // 变更目标配置或开关轮询时重置连续失败退避计数，避免旧目标的退避时间沿用到新目标
  useEffect(() => {
    consecutiveErrRef.current = 0;
    setConsecutiveErrors(0);
  }, [url, safeMethod, useProxy, enabled]);

  // 串行链式定时轮询（不会出现 setInterval 堆积重叠，且不受父组件内联回调引用变化干扰）
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!enabled || !mediaActive || !pageVisible || !isSafePollUrl(url)) {
      return;
    }

    let cancelled = false;
    const scheduleNext = () => {
      if (cancelled) return;
      const delayMs = computeBackoffDelayMs(safeInterval, consecutiveErrRef.current);
      timerRef.current = setTimeout(() => {
        if (cancelled) return;
        void executePollOnceRef.current().finally(() => {
          if (!cancelled) scheduleNext();
        });
      }, delayMs);
    };

    // 启动时先立即抓一次，结束后再按间隔（或退避时间）排下一次
    void executePollOnceRef.current().finally(() => {
      if (!cancelled) scheduleNext();
    });

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      abortRef.current?.abort();
    };
  }, [enabled, mediaActive, pageVisible, url, safeInterval, safeMethod, useProxy, jsonPath]);

  const commitInterval = (raw?: string) => {
    const normalized = normalizePollIntervalSec(raw !== undefined ? raw : intervalDraft);
    setIntervalDraft(String(normalized));
    onChangeInterval(normalized);
  };

  const commitUrl = (raw?: string) => {
    const trimmed = (raw !== undefined ? raw : urlDraft).trim();
    setUrlDraft(trimmed);
    onChangeUrl(trimmed);
  };

  const nextDelaySec = Math.round(computeBackoffDelayMs(safeInterval, consecutiveErrors) / 1000);

  return (
    <div className="flex flex-col gap-2 text-xs">
      {/* URL + 方法选择 */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag nopan nowheel flex items-center gap-1"
      >
        <select
          aria-label="HTTP 方法"
          value={safeMethod}
          onChange={(e) => onChangeMethod(normalizePollMethod(e.target.value))}
          className="nodrag nopan shrink-0 rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px] font-semibold text-slate-700 outline-none focus:border-blue-500"
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </select>
        <input
          type="url"
          value={urlDraft}
          placeholder="https://... 或 /api/proxy/status"
          style={{ touchAction: 'auto' }}
          onClick={(e) => {
            e.stopPropagation();
            e.currentTarget.focus();
          }}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={(e) => commitUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const nextTrimmed = e.currentTarget.value.trim();
              const changed = nextTrimmed !== url.trim();
              commitUrl(nextTrimmed);
              if (!enabled || !changed) {
                void executePollOnce(nextTrimmed);
              }
            }
          }}
          className="nodrag nopan nowheel min-w-0 flex-1 cursor-text select-text rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-900 outline-none focus:border-blue-500"
        />
      </div>

      {/* 间隔 + JSON 路径 + Proxy 开关 */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag nopan nowheel flex items-center gap-1.5"
      >
        <label className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-600">
          <span>每</span>
          <input
            type="number"
            min={2}
            max={3600}
            aria-label="轮询间隔秒数"
            value={intervalDraft}
            style={{ touchAction: 'auto' }}
            onChange={(e) => setIntervalDraft(e.target.value)}
            onBlur={(e) => commitInterval(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitInterval(e.currentTarget.value);
              }
            }}
            className="nodrag nopan nowheel w-12 cursor-text select-text rounded border border-slate-300 bg-white px-1 py-0.5 text-center font-mono text-[11px] text-slate-900 outline-none focus:border-blue-500"
          />
          <span>秒</span>
        </label>

        <input
          type="text"
          value={pathDraft}
          placeholder="提取路径 (如 data.price)"
          aria-label="JSON 提取路径"
          style={{ touchAction: 'auto' }}
          onChange={(e) => setPathDraft(e.target.value)}
          onBlur={(e) => onChangeJsonPath(e.currentTarget.value.trim())}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const nextPath = e.currentTarget.value.trim();
              const changed = nextPath !== jsonPath.trim();
              pathDraftRef.current = nextPath;
              onChangeJsonPath(nextPath);
              if (!enabled || !changed) {
                void executePollOnce();
              }
            }
          }}
          className="nodrag nopan nowheel min-w-0 flex-1 cursor-text select-text rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-800 outline-none focus:border-blue-500"
        />

        <label
          title="远程外链经 /api/proxy 转发（避免 CORS 并受白名单/SSRF 保护）"
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-slate-600 select-none"
        >
          <input
            type="checkbox"
            checked={useProxy}
            onChange={(e) => onChangeUseProxy(e.target.checked)}
            className="h-3.5 w-3.5 accent-blue-600"
          />
          <Globe className="h-3 w-3 text-slate-500" />
        </label>
      </div>

      {/* 控制按钮 + 运行状态 */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag nopan flex items-center justify-between gap-1.5"
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              commitUrl();
              commitInterval();
              onChangeJsonPath(pathDraft.trim());
              onChangeEnabled(!enabled);
            }}
            className={`inline-flex cursor-pointer items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium text-white transition ${
              enabled ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {enabled ? '暂停轮询' : '启动轮询'}
          </button>

          <button
            type="button"
            disabled={isFetching}
            onClick={(e) => {
              e.stopPropagation();
              commitUrl();
              onChangeJsonPath(pathDraft.trim());
              void executePollOnce(urlDraft);
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            立即抓取
          </button>
        </div>

        <div className="inline-flex items-center gap-1 text-[10.5px] text-slate-500">
          <Activity className={`h-3 w-3 ${enabled && mediaActive && pageVisible && isSafePollUrl(url) ? 'text-emerald-500' : 'text-slate-400'}`} />
          <span>
            {!mediaActive
              ? '离屏暂停'
              : !pageVisible
                ? '后台暂停'
                : enabled
                  ? !isSafePollUrl(url)
                    ? 'URL 无效'
                    : consecutiveErrors > 0
                      ? `退避 ${nextDelaySec}s`
                      : `每 ${safeInterval}s`
                  : '已暂停'}
          </span>
        </div>
      </div>

      {/* 状态元信息 */}
      <div className="flex flex-wrap items-center justify-between gap-1 rounded bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-600">
        <span>{lastStatus || '待抓取'}</span>
        <span>成功 {okCount} / 失败 {errCount}</span>
        <span>{lastUpdatedAt ? `更新 ${lastUpdatedAt}` : '尚未更新'}</span>
      </div>

      {errorMsg && (
        <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
          {errorMsg}
        </div>
      )}

      {/* 抓取结果预览区 */}
      <pre
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag nopan nowheel max-h-44 min-h-[72px] overflow-auto rounded-md border border-slate-200 bg-slate-950 p-2 font-mono text-[10.5px] leading-relaxed text-emerald-300 whitespace-pre-wrap break-all"
      >
        {lastValue || '暂无抓取数据 — 点击「立即抓取」或「启动轮询」获取接口数据'}
      </pre>
    </div>
  );
}

export const ApiPollerBlock = memo(ApiPollerBlockInner);
