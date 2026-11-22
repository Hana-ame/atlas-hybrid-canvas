const BLOCKED_TOKENS = [
  'window', 'document', 'globalThis', 'localStorage', 'sessionStorage',
  'indexedDB', 'cookie', 'eval', 'Function', 'AsyncFunction', 'Proxy',
  'Reflect', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker',
  'importScripts', 'navigator', 'location', 'history', 'postMessage',
  '__proto__', 'prototype', 'constructor', 'setPrototypeOf', 'getPrototypeOf',
];

const BLOCKED_VAR_KEYS = new Set([
  '__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
]);

export const MAX_COMPUTE_MS = 5000;

export function isSafeVarKey(key: string): boolean {
  return typeof key === 'string' && key.trim().length > 0 && key.length <= 64 && !BLOCKED_VAR_KEYS.has(key);
}

export function validateScriptSafety(code: string): { ok: boolean; reason?: string } {
  if (code.length > 16384) {
    return { ok: false, reason: '脚本超过 16KB 长度上限' };
  }
  for (const token of BLOCKED_TOKENS) {
    const re = new RegExp(`\\b${token}\\b`);
    if (re.test(code)) {
      return { ok: false, reason: `安全拦截：禁止在控件脚本中使用 ${token}` };
    }
  }
  return { ok: true };
}

export interface SandboxExecutionResult {
  ok: boolean;
  updatedVars: Record<string, unknown>;
  logs: string[];
  error?: string;
}

/**
 * 在一次性隔离 Web Worker 中编译并执行控件脚本（零 DOM/Cookie/Storage 权限 + 5 秒超时强杀）
 */
export async function runInIsolatedWorker(
  code: string,
  initialVars: Record<string, unknown>
): Promise<SandboxExecutionResult> {
  const check = validateScriptSafety(code);
  if (!check.ok) {
    return { ok: false, updatedVars: initialVars, logs: [], error: check.reason };
  }

  const workerBootstrap = `
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    self.onmessage = async (ev) => {
      const { code, initialVars } = ev.data;
      const logs = [];
      const vars = Object.assign(Object.create(null), initialVars || {});
      const log = (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
      const lib = {
        now: () => new Date().toLocaleTimeString(),
        inc: (key, delta = 1) => {
          const next = (Number(vars[key]) || 0) + Number(delta);
          vars[key] = Math.round(next * 1000) / 1000;
          return vars[key];
        },
      };
      try {
        const fn = new AsyncFunction('vars', 'lib', 'log', 'window', 'document', 'fetch', 'localStorage', code);
        await fn(vars, lib, log, undefined, undefined, undefined, undefined);
        const plainVars = {};
        for (const k of Object.keys(vars)) plainVars[k] = vars[k];
        self.postMessage({ ok: true, updatedVars: plainVars, logs });
      } catch (err) {
        self.postMessage({ ok: false, updatedVars: initialVars, logs, error: err instanceof Error ? err.message : String(err) });
      }
    };
  `;

  const blob = new Blob([workerBootstrap], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl);

  return new Promise<SandboxExecutionResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    };
    const finish = (res: SandboxExecutionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        updatedVars: initialVars,
        logs: [],
        error: `脚本执行超时（超过 ${MAX_COMPUTE_MS / 1000}s 已强杀 Worker）`,
      });
    }, MAX_COMPUTE_MS);

    worker.onmessage = (ev: MessageEvent<SandboxExecutionResult>) => {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ev.data.updatedVars || {})) {
        if (isSafeVarKey(k)) sanitized[k] = v;
      }
      finish({ ...ev.data, updatedVars: sanitized });
    };

    worker.onerror = (ev) => {
      finish({ ok: false, updatedVars: initialVars, logs: [], error: ev.message || 'Worker 运行异常' });
    };

    worker.postMessage({ code, initialVars });
  });
}
