import type { LocalAnnotationOverride } from './types';

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
  if (code.length > 24576) {
    return { ok: false, reason: '脚本超过 24KB 长度上限' };
  }
  for (const token of BLOCKED_TOKENS) {
    const re = new RegExp(`\\b${token}\\b`);
    if (re.test(code)) {
      return { ok: false, reason: `安全拦截：禁止在控件脚本中使用 ${token}` };
    }
  }
  return { ok: true };
}

export interface PeerWidgetSnapshot {
  id: string;
  title: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  vars: Record<string, unknown>;
}

export interface AnnotationScriptOp {
  id: string;
  patch: LocalAnnotationOverride;
}

export type WidgetScriptOp =
  | {
      op: 'create';
      id: string;
      title: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      category?: string;
      body?: string;
      connect?: string | boolean;
      vars?: Record<string, unknown>;
      script?: string;
    }
  | { op: 'connect'; fromId: string; toId: string; label?: string }
  | { op: 'remove'; id: string };

export interface EmitScriptOp {
  targetId: string | '*';
  event: string;
  payload: unknown;
}

export type ScriptTriggerEvent =
  | { kind: 'render' }
  | { kind: 'click'; buttonId: string }
  | { kind: 'submit'; inputId: string; value: string }
  | { kind: 'message'; event: string; payload: unknown; fromId: string; fromTitle: string };

export interface SandboxExecutionResult {
  ok: boolean;
  updatedVars: Record<string, unknown>;
  annotationOps: AnnotationScriptOp[];
  widgetOps: WidgetScriptOp[];
  emitOps: EmitScriptOp[];
  logs: string[];
  error?: string;
}

/**
 * 一次性隔离 Web Worker 执行引擎：
 * 同时兼容单按钮短脚本与统一控件脚本（vars.contents / on / onSubmit / emit / broadcast / widgets / canvas）
 */
export async function runInIsolatedWorker(
  code: string,
  initialVars: Record<string, unknown>,
  options?: {
    selfEntity?: PeerWidgetSnapshot;
    peers?: Record<string, PeerWidgetSnapshot>;
    trigger?: ScriptTriggerEvent;
  }
): Promise<SandboxExecutionResult> {
  const check = validateScriptSafety(code);
  if (!check.ok) {
    return {
      ok: false,
      updatedVars: initialVars,
      annotationOps: [],
      widgetOps: [],
      emitOps: [],
      logs: [],
      error: check.reason,
    };
  }

  const workerBootstrap = `
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    self.onmessage = async (ev) => {
      const { code, initialVars, selfEntity, peers, trigger } = ev.data;
      const logs = [];
      const annotationOps = [];
      const widgetOps = [];
      const emitOps = [];
      const peerMap = Object.assign(Object.create(null), peers || {});
      const vars = Object.assign(Object.create(null), initialVars || {});
      const ctx = {
        entity: selfEntity || { id: 'self', title: '控件', label: '控件', x: 0, y: 0, width: 280, height: 180, color: '#2563EB', vars: {} },
      };

      const log = (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
      const lib = {
        now: () => new Date().toLocaleTimeString(),
        inc: (key, delta = 1) => {
          const next = (Number(vars[key]) || 0) + Number(delta);
          vars[key] = Math.round(next * 1000) / 1000;
          return vars[key];
        },
      };
      const canvas = {
        setAnnotationBg: (id, bgColor, bgOpacity) => {
          const patch = { bgColor: String(bgColor) };
          if (bgOpacity !== undefined && Number.isFinite(Number(bgOpacity))) {
            patch.bgOpacity = Math.max(0, Math.min(1, Number(bgOpacity)));
          }
          annotationOps.push({ id: String(id), patch });
        },
        setAnnotationColor: (id, color) => annotationOps.push({ id: String(id), patch: { color: String(color) } }),
        setAnnotationText: (id, text) => annotationOps.push({ id: String(id), patch: { text: String(text) } }),
        setAnnotationImage: (id, imageUrl) => annotationOps.push({ id: String(id), patch: { imageUrl: String(imageUrl) } }),
      };

      let spawnSeq = 0;
      const widgets = {
        get: (id) => peerMap[String(id)] || null,
        vars: (id) => (peerMap[String(id)] && peerMap[String(id)].vars) || {},
        list: () => Object.values(peerMap),
        create: async (spec) => {
          if (!spec || typeof spec !== 'object') return { ok: false, error: '无效参数' };
          spawnSeq += 1;
          const id = spec.id ? String(spec.id) : ('child-' + Date.now() + '-' + spawnSeq);
          const title = String(spec.title || spec.label || ('子控件 #' + spawnSeq)).slice(0, 80);
          const x = Number.isFinite(Number(spec.x))
            ? Number(spec.x)
            : Math.round((ctx.entity.x || 0) + (Number(spec.dx) || 380));
          const y = Number.isFinite(Number(spec.y))
            ? Number(spec.y)
            : Math.round((ctx.entity.y || 0) + (Number(spec.dy) || 0));
          const width = Math.max(200, Math.min(800, Number(spec.w || spec.width) || 320));
          const height = Math.max(120, Math.min(600, Number(spec.h || spec.height) || 190));
          const color = typeof spec.color === 'string' ? spec.color : '#059669';
          const created = {
            op: 'create',
            id,
            title,
            x,
            y,
            width,
            height,
            color,
            category: spec.category ? String(spec.category) : '子控件',
            body: spec.body ? String(spec.body) : '',
            connect: spec.connect,
            vars: spec.vars && typeof spec.vars === 'object' ? spec.vars : {},
            script: typeof spec.script === 'string' ? spec.script : undefined,
          };
          widgetOps.push(created);
          peerMap[id] = { id, title, label: title, x, y, width, height, color, vars: created.vars || {} };
          return { ok: true, id, title };
        },
        connect: (fromId, toId, label) => {
          widgetOps.push({ op: 'connect', fromId: String(fromId), toId: String(toId), label: label ? String(label) : undefined });
          return { ok: true };
        },
        remove: (id) => {
          widgetOps.push({ op: 'remove', id: String(id) });
          delete peerMap[String(id)];
          return { ok: true };
        },
      };

      const emit = async (targetId, event, payload) => {
        const tid = String(targetId || '');
        if (!tid || !peerMap[tid]) return { ok: false, error: '目标控件不存在' };
        emitOps.push({ targetId: tid, event: String(event), payload });
        return { ok: true };
      };
      const broadcast = async (event, payload) => {
        emitOps.push({ targetId: '*', event: String(event), payload });
        return { ok: true };
      };

      const handlers = Object.create(null);
      const submitHandlers = Object.create(null);
      const on = (key, fn) => {
        if (typeof fn === 'function') handlers[String(key)] = fn;
      };
      const onSubmit = (inputId, fn) => {
        if (typeof fn === 'function') submitHandlers[String(inputId)] = fn;
      };

      const runUserCode = async () => {
        const fn = new AsyncFunction(
          'vars', 'ctx', 'lib', 'log', 'canvas', 'widgets', 'emit', 'broadcast', 'on', 'onSubmit',
          'window', 'document', 'fetch', 'localStorage',
          code
        );
        await fn(
          vars, ctx, lib, log, canvas, widgets, emit, broadcast, on, onSubmit,
          undefined, undefined, undefined, undefined
        );
      };

      try {
        // 第 1 遍：执行顶层代码，产出初始 vars.contents 并注册 on / onSubmit 回调
        await runUserCode();

        // 第 2 遍：若有事件触发（点击、回车提交或跨控件消息），执行对应回调后再重跑顶层以刷新 vars.contents
        if (trigger && trigger.kind === 'click' && handlers[trigger.buttonId]) {
          await handlers[trigger.buttonId](vars);
          await runUserCode();
        } else if (trigger && trigger.kind === 'submit' && submitHandlers[trigger.inputId]) {
          await submitHandlers[trigger.inputId](trigger.value, vars);
          await runUserCode();
        } else if (trigger && trigger.kind === 'message' && handlers[trigger.event]) {
          await handlers[trigger.event](trigger.payload, { fromId: trigger.fromId, fromTitle: trigger.fromTitle });
          await runUserCode();
        }

        const plainVars = {};
        for (const k of Object.keys(vars)) plainVars[k] = vars[k];
        self.postMessage({ ok: true, updatedVars: plainVars, annotationOps, widgetOps, emitOps, logs });
      } catch (err) {
        self.postMessage({
          ok: false,
          updatedVars: initialVars,
          annotationOps: [],
          widgetOps: [],
          emitOps: [],
          logs,
          error: err instanceof Error ? err.message : String(err),
        });
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
        annotationOps: [],
        widgetOps: [],
        emitOps: [],
        logs: [],
        error: `脚本执行超时（超过 ${MAX_COMPUTE_MS / 1000}s 已强杀 Worker）`,
      });
    }, MAX_COMPUTE_MS);

    worker.onmessage = (ev: MessageEvent<SandboxExecutionResult>) => {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ev.data.updatedVars || {})) {
        if (isSafeVarKey(k)) sanitized[k] = v;
      }
      finish({
        ...ev.data,
        updatedVars: sanitized,
        annotationOps: Array.isArray(ev.data.annotationOps) ? ev.data.annotationOps : [],
        widgetOps: Array.isArray(ev.data.widgetOps) ? ev.data.widgetOps : [],
        emitOps: Array.isArray(ev.data.emitOps) ? ev.data.emitOps : [],
      });
    };

    worker.onerror = (ev) => {
      finish({
        ok: false,
        updatedVars: initialVars,
        annotationOps: [],
        widgetOps: [],
        emitOps: [],
        logs: [],
        error: ev.message || 'Worker 运行异常',
      });
    };

    worker.postMessage({
      code,
      initialVars,
      selfEntity: options?.selfEntity,
      peers: options?.peers,
      trigger: options?.trigger ?? { kind: 'render' },
    });
  });
}
