import type { LocalAnnotationOverride } from './types';

const BLOCKED_TOKENS = [
  'window', 'document', 'globalThis', 'self', 'caches', 'EventSource', 'BroadcastChannel',
  'setTimeout', 'setInterval', 'localStorage', 'sessionStorage',
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

/**
 * 即时编译预检（不执行脚本），供属性检查器实时提示语法错误。
 */
export function validateScriptSyntax(code: string): { ok: boolean; error?: string } {
  const trimmed = code.trim();
  if (!trimmed) return { ok: true };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown;
    new AsyncFunction(
      'vars', 'ctx', 'lib', 'log', 'canvas', 'widgets', 'emit', 'broadcast', 'emitDownstream', 'on', 'onSubmit', 'onChange', 'onValidateConnect',
      'window', 'document', 'self', 'fetch', 'localStorage',
      `'use strict';\n${trimmed}`
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 有向无环图（DAG）连线检测：防止连线成环导致数据流无限递归。
 */
export function validateDagConnection(
  edges: Array<{ source: string; target: string }>,
  source: string,
  target: string
): { ok: boolean; reason?: string; cyclePath?: string[] } {
  if (!source || !target) return { ok: false, reason: '起点或终点无效' };
  if (source === target) return { ok: false, reason: '检测到自环连线', cyclePath: [source, target] };
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  // 判据：从 target 出发能否沿现有边走回 source。能走回 → 接上 source→target 就成环。
  // 注意不能反过来「从 source 出发能否回到 source」，那会把 source 自身早已存在的环也算到本次连线头上。
  const parent = new Map<string, string>();
  const visited = new Set<string>([target]);
  const queue: string[] = [target];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (next === source) {
        const path = [source, target];
        const chain: string[] = [];
        let node: string | undefined = cur;
        while (node && node !== target) {
          chain.push(node);
          node = parent.get(node);
        }
        chain.reverse();
        const cyclePath = [...path, ...chain, source];
        return {
          ok: false,
          reason: `检测到有向环路：${cyclePath.join(' → ')}`,
          cyclePath,
        };
      }
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, cur);
        queue.push(next);
      }
    }
  }
  return { ok: true };
}

/**
 * 拓扑排序（Kahn 算法）：供控件脚本与测试判断全图是否为 DAG 并获取执行顺序。
 */
export function computeTopologicalOrder(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
): { ok: boolean; order: string[]; cyclicNodeIds: string[] } {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  // 自环单独立账：若只把自环边丢掉，节点入度留在 0，会被 Kahn 当成正常源点出队，环就被抹平了
  for (const e of edges) {
    if (!inDegree.has(e.source)) { inDegree.set(e.source, 0); adj.set(e.source, []); }
    if (!inDegree.has(e.target)) { inDegree.set(e.target, 0); adj.set(e.target, []); }
    // 自环也要计入入度，否则会被 Kahn 当成正常源点出队、把环抹平；
    // 但不进邻接表，否则该节点出队时会把自身入度减回 0。
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    if (e.source === e.target) continue;
    adj.get(e.source)!.push(e.target);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nx of adj.get(cur) ?? []) {
      const nextDeg = (inDegree.get(nx) ?? 1) - 1;
      inDegree.set(nx, nextDeg);
      if (nextDeg === 0) queue.push(nx);
    }
  }
  const cyclicNodeIds = Array.from(inDegree.entries())
    .filter(([, deg]) => deg > 0)
    .map(([id]) => id);
  return { ok: cyclicNodeIds.length === 0, order, cyclicNodeIds };
}

export interface PeerWidgetSnapshot {
  id: string;
  title: string;
  label: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  vars: Record<string, unknown>;
}

export interface EdgeSnapshot {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
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

export interface ConnectValidationPayload {
  source: string;
  target: string;
  fromPort: string;
  toPort: string;
  fromNode: PeerWidgetSnapshot | null;
  toNode: PeerWidgetSnapshot | null;
  wouldCycle: boolean;
  cyclePath: string[];
}

export type ScriptTriggerEvent =
  | { kind: 'render' }
  | { kind: 'click'; buttonId: string }
  | { kind: 'submit'; inputId: string; value: string }
  | { kind: 'message'; event: string; payload: unknown; fromId: string; fromTitle: string }
  | { kind: 'varsChanged'; prevVars: Record<string, unknown>; changedKeys: string[] }
  | { kind: 'validateConnect'; conn: ConnectValidationPayload };

export interface SandboxExecutionResult {
  ok: boolean;
  updatedVars: Record<string, unknown>;
  annotationOps: AnnotationScriptOp[];
  widgetOps: WidgetScriptOp[];
  emitOps: EmitScriptOp[];
  logs: string[];
  connectValidation?: { ok: boolean; reason?: string };
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
    edges?: EdgeSnapshot[];
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
    const _post = self.postMessage.bind(self);
    const _proto = Object.getPrototypeOf(self);
    for (const api of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'BroadcastChannel', 'importScripts', 'indexedDB', 'caches', 'setTimeout', 'setInterval', 'postMessage']) {
      try { Object.defineProperty(self, api, { value: undefined, writable: false, configurable: false }); } catch {}
      if (_proto) { try { Object.defineProperty(_proto, api, { value: undefined, writable: false, configurable: false }); } catch {} }
    }
    self.onmessage = async (ev) => {
      const { code, initialVars, selfEntity, peers, edges, trigger } = ev.data;
      const logs = [];
      const annotationOps = [];
      const widgetOps = [];
      const emitOps = [];
      let suppressSideEffects = false;
      const peerMap = Object.assign(Object.create(null), peers || {});
      const edgeList = Array.isArray(edges) ? edges.slice() : [];
      const vars = Object.assign(Object.create(null), initialVars || {});
      const ctx = {
        entity: selfEntity || { id: 'self', title: '控件', label: '控件', body: '', x: 0, y: 0, width: 280, height: 180, color: '#2563EB', vars: {} },
      };

      const log = (...args) => { if (!suppressSideEffects) logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); };
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
          if (!suppressSideEffects) annotationOps.push({ id: String(id), patch });
        },
        setAnnotationColor: (id, color) => { if (!suppressSideEffects) annotationOps.push({ id: String(id), patch: { color: String(color) } }); },
        setAnnotationText: (id, text) => { if (!suppressSideEffects) annotationOps.push({ id: String(id), patch: { text: String(text) } }); },
        setAnnotationImage: (id, imageUrl) => { if (!suppressSideEffects) annotationOps.push({ id: String(id), patch: { imageUrl: String(imageUrl) } }); },
      };

      let spawnSeq = 0;
      const widgets = {
        get: (id) => peerMap[String(id)] || null,
        vars: (id) => (peerMap[String(id)] && peerMap[String(id)].vars) || {},
        list: () => Object.values(peerMap),
        edges: () => edgeList.slice(),
        inputs: (portId) => {
          const wantPort = portId ? String(portId) : '';
          return edgeList
            .filter((e) => e.target === ctx.entity.id && (!wantPort || (e.targetHandle || 'in-1') === wantPort))
            .map((e) => {
              const src = peerMap[e.source];
              if (!src) return null;
              return Object.assign({}, src, {
                edgeId: e.id,
                fromPort: e.sourceHandle || 'out-1',
                toPort: e.targetHandle || 'in-1',
                edgeLabel: e.label || '',
              });
            })
            .filter(Boolean);
        },
        outputs: (portId) => {
          const wantPort = portId ? String(portId) : '';
          return edgeList
            .filter((e) => e.source === ctx.entity.id && (!wantPort || (e.sourceHandle || 'out-1') === wantPort))
            .map((e) => {
              const dst = peerMap[e.target];
              if (!dst) return null;
              return Object.assign({}, dst, {
                edgeId: e.id,
                fromPort: e.sourceHandle || 'out-1',
                toPort: e.targetHandle || 'in-1',
                edgeLabel: e.label || '',
              });
            })
            .filter(Boolean);
        },
        create: async (spec) => {
          if (suppressSideEffects) return { ok: false, skipped: true };
          if (!spec || typeof spec !== 'object') return { ok: false, error: '无效参数' };
          spawnSeq += 1;
          const id = spec.id ? String(spec.id) : ('child-' + Date.now() + '-' + spawnSeq);
          const title = String(spec.title || spec.label || ('子控件 #' + spawnSeq)).slice(0, 80);
          const hasNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
          const dx = hasNum(spec.dx) ? Number(spec.dx) : 380;
          const dy = hasNum(spec.dy) ? Number(spec.dy) : 0;
          const x = hasNum(spec.x)
            ? Number(spec.x)
            : Math.round((ctx.entity.x || 0) + dx);
          const y = hasNum(spec.y)
            ? Number(spec.y)
            : Math.round((ctx.entity.y || 0) + dy);
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
          peerMap[id] = { id, title, label: title, body: created.body || '', x, y, width, height, color, vars: created.vars || {} };
          if (spec.connect) {
            edgeList.push({
              id: 'tmp-edge-' + ctx.entity.id + '-' + id,
              source: ctx.entity.id,
              target: id,
              sourceHandle: 'out-1',
              targetHandle: 'in-1',
              label: typeof spec.connect === 'string' ? spec.connect : '',
            });
          }
          return { ok: true, id, title };
        },
        checkDag: (fromId, toId) => {
          const adj = Object.create(null);
          for (const e of edgeList) {
            if (!adj[e.source]) adj[e.source] = [];
            // 自环不入邻接表：否则 BFS 会把自环误当成普通出边
            if (e.source === e.target) continue;
            adj[e.source].push(e.target);
          }
          if (fromId !== undefined && toId !== undefined) {
            const f = String(fromId || '');
            const t = String(toId || '');
            if (!f || !t) return { ok: false, cyclePath: [] };
            if (f === t) return { ok: false, cyclePath: [f, t] };
            // 只看「除这条新边之外的现有拓扑」：fromId→toId 这条边此刻还没进 edgeList。
            // 判据是「从 t 出发能否走回 f」——能走回，接上新边就成环；f 自身已存在环与本次连线无关。
            const parent = Object.create(null);
            const visited = new Set([t]);
            const queue = [t];
            while (queue.length > 0) {
              const cur = queue.shift();
              for (const nx of (adj[cur] || [])) {
                if (nx === f) {
                  // cur → ... → t 的路径反向回溯，再整体翻回正向，拼成 f → t → ... → cur → f
                  const back = [];
                  let node = cur;
                  while (node && node !== t) { back.push(node); node = parent[node]; }
                  back.reverse();
                  return { ok: false, cyclePath: [f, t, ...back, f] };
                }
                if (!visited.has(nx)) { visited.add(nx); parent[nx] = cur; queue.push(nx); }
              }
            }
            return { ok: true, cyclePath: [] };
          }
          // 全图 Kahn 拓扑检测
          const inDeg = Object.create(null);
          for (const id of Object.keys(peerMap)) inDeg[id] = 0;
          for (const e of edgeList) {
            if (!(e.source in inDeg)) { inDeg[e.source] = 0; if (!adj[e.source]) adj[e.source] = []; }
            if (!(e.target in inDeg)) { inDeg[e.target] = 0; if (!adj[e.target]) adj[e.target] = []; }
            inDeg[e.target] = (inDeg[e.target] || 0) + 1;
          }
          const q = Object.keys(inDeg).filter((k) => inDeg[k] === 0);
          while (q.length > 0) {
            const cur = q.shift();
            for (const nx of (adj[cur] || [])) {
              inDeg[nx] = (inDeg[nx] || 1) - 1;
              if (inDeg[nx] === 0) q.push(nx);
            }
          }
          const cyclic = Object.keys(inDeg).filter((k) => inDeg[k] > 0);
          return { ok: cyclic.length === 0, cyclePath: cyclic };
        },
        topoSort: () => {
          const adj = Object.create(null);
          const inDeg = Object.create(null);
          for (const id of Object.keys(peerMap)) { inDeg[id] = 0; adj[id] = []; }
          for (const e of edgeList) {
            if (!adj[e.source]) { adj[e.source] = []; inDeg[e.source] = 0; }
            if (!(e.target in inDeg)) { inDeg[e.target] = 0; adj[e.target] = []; }
            // 自环计入入度（否则被当成源点出队、环被抹平），但不进邻接表（否则出队时把自身入度减回 0）
            inDeg[e.target] += 1;
            if (e.source === e.target) continue;
            adj[e.source].push(e.target);
          }
          const q = Object.keys(inDeg).filter((k) => inDeg[k] === 0);
          const order = [];
          while (q.length > 0) {
            const cur = q.shift();
            order.push(cur);
            for (const nx of (adj[cur] || [])) {
              inDeg[nx] -= 1;
              if (inDeg[nx] === 0) q.push(nx);
            }
          }
          const cyclicNodeIds = Object.keys(inDeg).filter((k) => inDeg[k] > 0);
          return { ok: cyclicNodeIds.length === 0, order, cyclicNodeIds };
        },
        connect: (fromId, toId, label) => {
          if (suppressSideEffects) return { ok: false, skipped: true };
          const f = String(fromId || '');
          const t = String(toId || '');
          if (!f || !t) return { ok: false, error: '起点或终点无效' };
          const lbl = label ? String(label) : undefined;
          widgetOps.push({ op: 'connect', fromId: f, toId: t, label: lbl });
          edgeList.push({ id: 'tmp-edge-' + f + '-' + t, source: f, target: t, sourceHandle: 'out-1', targetHandle: 'in-1', label: lbl });
          return { ok: true };
        },
        remove: (id) => {
          if (suppressSideEffects) return { ok: false, skipped: true };
          const rid = String(id);
          widgetOps.push({ op: 'remove', id: rid });
          delete peerMap[rid];
          for (let i = edgeList.length - 1; i >= 0; i--) {
            if (edgeList[i].source === rid || edgeList[i].target === rid) edgeList.splice(i, 1);
          }
          return { ok: true };
        },
      };

      const emit = async (targetId, event, payload) => {
        if (suppressSideEffects) return { ok: false, skipped: true };
        const tid = String(targetId || '');
        if (!tid || !peerMap[tid]) return { ok: false, error: '目标控件不存在' };
        emitOps.push({ targetId: tid, event: String(event), payload });
        return { ok: true };
      };
      const broadcast = async (event, payload) => {
        if (suppressSideEffects) return { ok: false, skipped: true };
        emitOps.push({ targetId: '*', event: String(event), payload });
        return { ok: true };
      };
      const emitDownstream = async (event, payload, portId) => {
        if (suppressSideEffects) return { ok: false, count: 0, skipped: true };
        const outs = widgets.outputs(portId);
        // 同一出口可能有 2 条边连到同一个下游控件（如 out-1 双出线），按控件去重，
        // 否则 count 会虚高、接收方也会被同一条消息触发两次。
        const targetIds = [];
        const seen = new Set();
        for (const dst of outs) {
          if (seen.has(dst.id)) continue;
          seen.add(dst.id);
          targetIds.push(dst.id);
        }
        if (targetIds.length === 0) return { ok: false, count: 0, error: '当前出口尚未连线到任何下游控件' };
        for (const tid of targetIds) {
          emitOps.push({ targetId: tid, event: String(event), payload });
        }
        return { ok: true, count: targetIds.length };
      };

      const handlers = Object.create(null);
      const submitHandlers = Object.create(null);
      let changeHandlers = Object.create(null);
      let connectValidator = null;
      const on = (key, fn) => {
        if (typeof fn === 'function') handlers[String(key)] = fn;
      };
      const onSubmit = (inputId, fn) => {
        if (typeof fn === 'function') submitHandlers[String(inputId)] = fn;
      };
      const onChange = (keyOrKeys, fn) => {
        if (typeof fn !== 'function') return;
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const rawK of keys) {
          const k = String(rawK || '');
          if (!k) continue;
          if (!changeHandlers[k]) changeHandlers[k] = [];
          changeHandlers[k].push(fn);
        }
      };
      const onValidateConnect = (fn) => {
        if (typeof fn === 'function') connectValidator = fn;
      };

      const cloneValue = (v) => {
        if (v === null || typeof v !== 'object') return v;
        try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
      };
      const snapshotVars = (obj) => {
        const snap = Object.create(null);
        for (const k of Object.keys(obj || {})) {
          snap[k] = cloneValue(obj[k]);
        }
        return snap;
      };
      const valuesEqual = (a, b) => {
        if (Object.is(a, b)) return true;
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
        }
        return false;
      };
      const diffChangedKeys = (prevSnap, nextObj) => {
        const allKeys = new Set([...Object.keys(prevSnap || {}), ...Object.keys(nextObj || {})]);
        const changed = [];
        for (const k of allKeys) {
          if (!valuesEqual(prevSnap ? prevSnap[k] : undefined, nextObj ? nextObj[k] : undefined)) {
            changed.push(k);
          }
        }
        return changed;
      };
      const runChangeWatchers = async (initialPrevSnap, explicitKeys) => {
        if (Object.keys(changeHandlers).length === 0) return false;
        let prevSnap = initialPrevSnap || Object.create(null);
        let keysToNotify = Array.isArray(explicitKeys) && explicitKeys.length > 0
          ? explicitKeys.filter((k) => !valuesEqual(prevSnap[k], vars[k]))
          : diffChangedKeys(prevSnap, vars);
        let anyFired = false;
        const MAX_REACTION_PASSES = 3;
        for (let pass = 0; pass < MAX_REACTION_PASSES && keysToNotify.length > 0; pass++) {
          const passStartSnap = snapshotVars(vars);
          for (const k of keysToNotify) {
            const nextVal = vars[k];
            const prevVal = prevSnap[k];
            const specific = changeHandlers[k] || [];
            const wildcard = k === 'contents' ? [] : (changeHandlers['*'] || []);
            for (const fn of [...specific, ...wildcard]) {
              anyFired = true;
              await fn(nextVal, prevVal, k);
            }
          }
          prevSnap = passStartSnap;
          keysToNotify = diffChangedKeys(passStartSnap, vars);
        }
        return anyFired;
      };

      const runUserCode = async () => {
        changeHandlers = Object.create(null);
        const fn = new AsyncFunction(
          'vars', 'ctx', 'lib', 'log', 'canvas', 'widgets', 'emit', 'broadcast', 'emitDownstream', 'on', 'onSubmit', 'onChange', 'onValidateConnect',
          'window', 'document', 'self', 'fetch', 'localStorage',
          "'use strict'; " + code
        );
        await fn(
          vars, ctx, lib, log, canvas, widgets, emit, broadcast, emitDownstream, on, onSubmit, onChange, onValidateConnect,
          undefined, undefined, undefined, undefined, undefined
        );
      };

      try {
        // 第 1 遍：执行顶层代码，非 render 触发时静默注册回调，避免顶层 log/canvas 副作用重复下发
        const isEventTrigger = Boolean(trigger && trigger.kind !== 'render');
        suppressSideEffects = isEventTrigger;
        await runUserCode();
        suppressSideEffects = false;

        // 连线前校验钩子：仅运行控件自带的 onValidateConnect，不修改 vars
        if (trigger && trigger.kind === 'validateConnect') {
          let connectValidation = { ok: true };
          if (connectValidator) {
            const raw = await connectValidator(trigger.conn);
            if (raw === false) {
              connectValidation = { ok: false, reason: ctx.entity.title + ' 拒绝了此连线' };
            } else if (raw && typeof raw === 'object' && raw.ok === false) {
              connectValidation = { ok: false, reason: String(raw.reason || (ctx.entity.title + ' 拒绝了此连线')) };
            }
          }
          _post({ ok: true, updatedVars: initialVars, annotationOps: [], widgetOps: [], emitOps: [], logs, connectValidation });
          return;
        }

        // 第 2 遍：若有事件触发（点击、回车提交、跨控件消息或外部变量变更），执行回调 + onChange 响应后再重跑顶层以刷新 vars.contents
        if (trigger && trigger.kind === 'varsChanged') {
          const fired = await runChangeWatchers(trigger.prevVars || Object.create(null), trigger.changedKeys);
          if (fired) {
            await runUserCode();
          }
        } else if (trigger && trigger.kind === 'click' && handlers[trigger.buttonId]) {
          const beforeSnap = snapshotVars(vars);
          await handlers[trigger.buttonId](vars);
          await runChangeWatchers(beforeSnap);
          await runUserCode();
        } else if (trigger && trigger.kind === 'submit' && submitHandlers[trigger.inputId]) {
          const beforeSnap = snapshotVars(vars);
          await submitHandlers[trigger.inputId](trigger.value, vars);
          await runChangeWatchers(beforeSnap);
          await runUserCode();
        } else if (trigger && trigger.kind === 'message' && handlers[trigger.event]) {
          const beforeSnap = snapshotVars(vars);
          await handlers[trigger.event](trigger.payload, { fromId: trigger.fromId, fromTitle: trigger.fromTitle });
          await runChangeWatchers(beforeSnap);
          await runUserCode();
        }

        const plainVars = {};
        for (const k of Object.keys(vars)) plainVars[k] = vars[k];
        _post({ ok: true, updatedVars: plainVars, annotationOps, widgetOps, emitOps, logs });
      } catch (err) {
        _post({
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

  const worker = acquirePooledWorker(workerBootstrap);

  return new Promise<SandboxExecutionResult>((resolve) => {
    let settled = false;

    const finish = (res: SandboxExecutionResult, reusable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      releasePooledWorker(worker, reusable);
      resolve(res);
    };

    const timer = setTimeout(() => {
      finish(
        {
          ok: false,
          updatedVars: initialVars,
          annotationOps: [],
          widgetOps: [],
          emitOps: [],
          logs: [],
          error: `脚本执行超时（超过 ${MAX_COMPUTE_MS / 1000}s 已强杀 Worker）`,
        },
        false
      );
    }, MAX_COMPUTE_MS);

    worker.onmessage = (ev: MessageEvent<SandboxExecutionResult>) => {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ev.data.updatedVars || {})) {
        if (isSafeVarKey(k)) sanitized[k] = v;
      }
      finish(
        {
          ...ev.data,
          updatedVars: sanitized,
          annotationOps: Array.isArray(ev.data.annotationOps) ? ev.data.annotationOps : [],
          widgetOps: Array.isArray(ev.data.widgetOps) ? ev.data.widgetOps : [],
          emitOps: Array.isArray(ev.data.emitOps) ? ev.data.emitOps : [],
        },
        Boolean(ev.data && ev.data.ok)
      );
    };

    worker.onerror = (ev) => {
      finish(
        {
          ok: false,
          updatedVars: initialVars,
          annotationOps: [],
          widgetOps: [],
          emitOps: [],
          logs: [],
          error: ev.message || 'Worker 运行异常',
        },
        false
      );
    };

    worker.postMessage({
      code,
      initialVars,
      selfEntity: options?.selfEntity,
      peers: options?.peers,
      edges: options?.edges,
      trigger: options?.trigger ?? { kind: 'render' },
    });
  });
}

// 常驻可复用 Worker 池（最多保留 MAX_POOLED_WORKERS 个空闲 Worker，避免链式事件高频冷启动/GC 抖动）
// 扇出并发时会同时占用多个 Worker，池容量需不低于常见扇出宽度，否则并发退化为冷启动。
// 每次脚本执行完毕立即销毁 Worker（0 池复用），彻底杜绝跨控件内置对象篡改与残留任务串扰
const MAX_POOLED_WORKERS = 0;
let cachedWorkerBlobUrl: string | null = null;
const idleWorkerPool: Worker[] = [];

function acquirePooledWorker(bootstrapCode: string): Worker {
  const existing = idleWorkerPool.pop();
  if (existing) return existing;
  if (!cachedWorkerBlobUrl) {
    const blob = new Blob([bootstrapCode], { type: 'application/javascript' });
    cachedWorkerBlobUrl = URL.createObjectURL(blob);
  }
  return new Worker(cachedWorkerBlobUrl);
}

function releasePooledWorker(worker: Worker, reusable: boolean): void {
  if (reusable && idleWorkerPool.length < MAX_POOLED_WORKERS) {
    idleWorkerPool.push(worker);
    return;
  }
  worker.terminate();
}
