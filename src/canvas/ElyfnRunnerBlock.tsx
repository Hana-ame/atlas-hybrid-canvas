/**
 * @file ElyfnRunnerBlock.tsx
 * @description elyfn 函数目录与调用控件：
 * - 自动从 `GET <baseUrl>/catalog` 拉取已部署函数目录（只读，不含源码）；
 * - 支持下拉选择函数、编辑 JSON 入参、可选 Bearer 执行密钥与一键调用 `POST /:folder/:fn`；
 * - 将执行结果同步写回节点 vars，供下游连线控件联动消费。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, Play, RefreshCw, Terminal } from 'lucide-react';

export interface ElyfnCatalogItem {
  folder: string;
  name: string;
  id: string;
  endpoint: string;
}

export interface ElyfnRunnerBlockProps {
  baseUrl?: string;
  selectedFn?: string;
  payloadText?: string;
  lastStatus?: string;
  lastResult?: string;
  lastUpdatedAt?: string;
  mediaActive?: boolean;
  onChangeBaseUrl: (next: string) => void;
  onChangeSelectedFn: (next: string) => void;
  onChangePayload: (next: string) => void;
  onRunResult: (result: {
    selectedFn: string;
    status: string;
    result: string;
    updatedAt: string;
    error: string;
  }) => void;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function parseCatalogItems(data: unknown): ElyfnCatalogItem[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.endpoints)) {
    return obj.endpoints
      .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
      .map((e) => {
        const folder = String(e.folder ?? '');
        const name = String(e.name ?? '');
        const id = String(e.id ?? `${folder}/${name}`);
        const endpoint = String(e.endpoint ?? `/${id}`);
        return { folder, name, id, endpoint };
      })
      .filter((e) => Boolean(e.folder && e.name));
  }
  if (obj.functions && typeof obj.functions === 'object') {
    const items: ElyfnCatalogItem[] = [];
    for (const [folder, list] of Object.entries(obj.functions as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const rawName of list) {
        const name = String(rawName).replace(/\.(js|ts)$/i, '');
        if (!name) continue;
        items.push({ folder, name, id: `${folder}/${name}`, endpoint: `/${folder}/${name}` });
      }
    }
    return items;
  }
  return [];
}

function ElyfnRunnerBlockInner({
  baseUrl = '',
  selectedFn = '',
  payloadText = '{}',
  lastStatus = '',
  lastResult = '',
  lastUpdatedAt = '',
  mediaActive = true,
  onChangeBaseUrl,
  onChangeSelectedFn,
  onChangePayload,
  onRunResult,
}: ElyfnRunnerBlockProps) {
  const [baseDraft, setBaseDraft] = useState(baseUrl);
  const [fnDraft, setFnDraft] = useState(selectedFn);
  const [payloadDraft, setPayloadDraft] = useState(payloadText || '{}');
  const [execKey, setExecKey] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);

  const [catalog, setCatalog] = useState<ElyfnCatalogItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setBaseDraft(baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    setFnDraft(selectedFn);
  }, [selectedFn]);

  useEffect(() => {
    setPayloadDraft(payloadText || '{}');
  }, [payloadText]);

  const fetchCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setErrorMsg('');
    try {
      const prefix = normalizeBaseUrl(baseDraft);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (execKey.trim()) {
        headers.Authorization = `Bearer ${execKey.trim()}`;
      }
      const res = await fetch(`${prefix}/catalog`, { method: 'GET', headers });
      const data = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!res.ok) {
        const msg = (data as Record<string, unknown>)?.error
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`;
        setErrorMsg(`拉取目录失败：${msg}`);
        return;
      }
      const items = parseCatalogItems(data);
      setCatalog(items);
      if (!fnDraft.trim() && items.length > 0) {
        setFnDraft(items[0].id);
        onChangeSelectedFn(items[0].id);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(`目录请求异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mountedRef.current) setLoadingCatalog(false);
    }
  }, [baseDraft, execKey, fnDraft, onChangeSelectedFn]);

  useEffect(() => {
    if (!mediaActive) return;
    void fetchCatalog();
  }, [mediaActive, fetchCatalog]);

  const runFunction = useCallback(async () => {
    const target = fnDraft.trim().replace(/^\/+/, '');
    if (!target || !target.includes('/')) {
      setErrorMsg('请先选择或输入合法函数路径（如 folder/fn）');
      return;
    }

    let parsedPayload: unknown = {};
    const trimmedPayload = payloadDraft.trim();
    if (trimmedPayload) {
      try {
        parsedPayload = JSON.parse(trimmedPayload);
      } catch {
        setErrorMsg('入参不是合法 JSON，请检查格式');
        return;
      }
    }

    setRunning(true);
    setErrorMsg('');
    const t0 = Date.now();
    try {
      const prefix = normalizeBaseUrl(baseDraft);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (execKey.trim()) {
        headers.Authorization = `Bearer ${execKey.trim()}`;
      }
      const res = await fetch(`${prefix}/${target}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsedPayload),
      });
      const elapsed = Date.now() - t0;
      const text = await res.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // 保留原始文本
      }
      const statusText = `${res.status} (${elapsed}ms)`;
      const updatedAt = new Date().toLocaleTimeString();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErrorMsg(`执行失败 ${statusText}`);
      }
      onRunResult({
        selectedFn: target,
        status: statusText,
        result: formatted.slice(0, 4000),
        updatedAt,
        error: res.ok ? '' : formatted.slice(0, 500),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`调用失败：${msg}`);
      onRunResult({
        selectedFn: target,
        status: 'ERR',
        result: '',
        updatedAt: new Date().toLocaleTimeString(),
        error: msg,
      });
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [baseDraft, execKey, fnDraft, onRunResult, payloadDraft]);

  return (
    <div
      className="nodrag nopan nowheel flex w-full flex-col gap-2 rounded-md border border-violet-200 bg-violet-50/40 p-2 text-xs text-slate-800"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 顶栏：目录拉取 + Key 切换 */}
      <div className="flex items-center gap-1.5">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-violet-600" />
        <select
          value={catalog.some((c) => c.id === fnDraft) ? fnDraft : ''}
          onChange={(e) => {
            const v = e.target.value;
            setFnDraft(v);
            onChangeSelectedFn(v);
          }}
          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs outline-none focus:border-violet-500"
        >
          <option value="">
            {catalog.length > 0 ? `选择函数（共 ${catalog.length} 个）…` : '暂无已部署函数，可手动输入'}
          </option>
          {catalog.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          title="刷新函数目录 (/catalog)"
          disabled={loadingCatalog}
          onClick={() => void fetchCatalog()}
          className="inline-flex items-center justify-center rounded border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingCatalog ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          title="配置可选执行密钥 (Bearer EXEC_KEY)"
          onClick={() => setShowKeyInput((v) => !v)}
          className={`inline-flex items-center justify-center rounded border p-1.5 ${
            execKey ? 'border-violet-400 bg-violet-100 text-violet-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
          }`}
        >
          <KeyRound className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 手动函数路径输入 + 可选基址/密钥 */}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={fnDraft}
          placeholder="folder/fn（如 demo/greet）"
          onChange={(e) => setFnDraft(e.target.value)}
          onBlur={() => onChangeSelectedFn(fnDraft.trim())}
          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] outline-none focus:border-violet-500"
        />
        <button
          type="button"
          disabled={running}
          onClick={() => void runFunction()}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-violet-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-800 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          <span>执行</span>
        </button>
      </div>

      {showKeyInput && (
        <div className="flex flex-col gap-1 rounded border border-violet-200 bg-white p-1.5">
          <input
            type="text"
            value={baseDraft}
            placeholder="服务基址（留空走当前同源，如 https://fn.example.com）"
            onChange={(e) => setBaseDraft(e.target.value)}
            onBlur={() => onChangeBaseUrl(baseDraft.trim())}
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-violet-500"
          />
          <input
            type="password"
            value={execKey}
            placeholder="可选 Bearer EXEC_KEY（仅存当前会话内存）"
            onChange={(e) => setExecKey(e.target.value)}
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-violet-500"
          />
        </div>
      )}

      {/* JSON 入参 */}
      <textarea
        rows={3}
        value={payloadDraft}
        placeholder='JSON 入参，例如 {"x": 5}'
        onChange={(e) => setPayloadDraft(e.target.value)}
        onBlur={() => onChangePayload(payloadDraft)}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-800 outline-none focus:border-violet-500"
      />

      {/* 状态与返回结果 */}
      {errorMsg && (
        <div className="rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">{errorMsg}</div>
      )}
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>状态：{lastStatus || '未调用'}</span>
        <span>{lastUpdatedAt ? `更新于 ${lastUpdatedAt}` : ''}</span>
      </div>
      {lastResult && (
        <pre className="max-h-32 overflow-auto rounded border border-slate-200 bg-slate-900 p-2 font-mono text-[11px] leading-relaxed text-emerald-300">
          {lastResult}
        </pre>
      )}
    </div>
  );
}

export const ElyfnRunnerBlock = memo(ElyfnRunnerBlockInner);
