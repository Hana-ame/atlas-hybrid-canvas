/**
 * @file agentOps.ts
 * @description 面向外部 AI Agent / MCP / 自动化工作流的声明式画布操作引擎（纯函数、原子批处理）。
 *
 * 支持 9 类高层语义操作（无需 Agent 手动维护全量蓝图 JSON 或 CRDT rev/fieldRevs）：
 * - 模板实例化：create_from_template（直接复用 BUILTIN_TEMPLATES 的 22 套内置控件/背景模板）
 * - 控件节点：create_widget（支持 blocks 结构化积木）/ update_widget / delete_widget
 * - 背景注释/插图层：create_annotation / update_annotation / delete_annotation
 * - 连线拓扑：connect_edge / delete_edge
 *
 * 特性：
 * 1. 自动防重叠布局（缺省 x/y 时调用 findNonOverlappingPosition）；
 * 2. 写入前强制安全校验（validateScriptSafety 校验脚本，isSafeImageUrl 校验背景图）；
 * 3. 批处理全有或全无（任一操作失败则整批回滚，不产生半截状态）；
 * 4. 提供面向 LLM 低 Token 消耗的状态摘要 summarizeBlueprintForAgent()。
 */

import type {
  AnnotationKind,
  BaseBlueprint,
  BlueprintEdge,
  BlueprintNode,
  CanvasAnnotation,
  ContentFlowItem,
  NodePortSpec,
  WidgetButtonSpec,
} from './types';
import { isSafeImageUrl, isSafeVideoUrl } from './mediaHelper';
import { isSafePdfUrl } from './pdfHelper';
import { isSafePollUrl } from './apiPoller';
import { findNonOverlappingPosition, type RectBox } from './placement';
import { validateScriptSafety } from './scriptSandbox';
import { BUILTIN_TEMPLATES } from './widgetTemplates';

export interface CreateFromTemplateOp {
  op: 'create_from_template';
  templateId: string;
  id?: string;
  title?: string;
  body?: string;
  text?: string;
  imageUrl?: string;
  color?: string;
  bgColor?: string;
  bgOpacity?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  defaultVars?: Record<string, unknown>;
}

export interface CreateWidgetOp {
  op: 'create_widget';
  id?: string;
  title: string;
  body?: string;
  category?: string;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  script?: string;
  locked?: boolean;
  defaultVars?: Record<string, unknown>;
  /** 可选：直接传入结构化内容积木（自动写入 defaultVars.contents，无需手写脚本） */
  blocks?: ContentFlowItem[];
  buttons?: WidgetButtonSpec[];
  inputPorts?: NodePortSpec[];
  outputPorts?: NodePortSpec[];
}

export interface UpdateWidgetOp {
  op: 'update_widget';
  id: string;
  title?: string;
  body?: string;
  category?: string;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  script?: string;
  locked?: boolean;
  defaultVars?: Record<string, unknown>;
  /** 默认 true：浅合并 defaultVars；设为 false 则整体替换 */
  mergeVars?: boolean;
  blocks?: ContentFlowItem[];
  buttons?: WidgetButtonSpec[];
  inputPorts?: NodePortSpec[];
  outputPorts?: NodePortSpec[];
}

export interface DeleteWidgetOp {
  op: 'delete_widget';
  id: string;
}

export interface CreateAnnotationOp {
  op: 'create_annotation';
  id?: string;
  kind?: AnnotationKind;
  text?: string;
  imageUrl?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
  bgColor?: string;
  bgOpacity?: number;
  weight?: 'normal' | 'bold';
  nonInteractive?: boolean;
}

export interface UpdateAnnotationOp {
  op: 'update_annotation';
  id: string;
  text?: string;
  imageUrl?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
  bgColor?: string;
  bgOpacity?: number;
  weight?: 'normal' | 'bold';
  nonInteractive?: boolean;
}

export interface DeleteAnnotationOp {
  op: 'delete_annotation';
  id: string;
}

export interface ConnectEdgeOp {
  op: 'connect_edge';
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  color?: string;
  dashed?: boolean;
  bidirectional?: boolean;
}

export interface DeleteEdgeOp {
  op: 'delete_edge';
  id: string;
}

export type AgentOperation =
  | CreateFromTemplateOp
  | CreateWidgetOp
  | UpdateWidgetOp
  | DeleteWidgetOp
  | CreateAnnotationOp
  | UpdateAnnotationOp
  | DeleteAnnotationOp
  | ConnectEdgeOp
  | DeleteEdgeOp;

export interface AgentOpItemResult {
  index: number;
  op: AgentOperation['op'];
  id: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export type ApplyAgentOpsResult =
  | {
      ok: true;
      blueprint: BaseBlueprint;
      results: AgentOpItemResult[];
      summary: string;
    }
  | {
      ok: false;
      error: string;
      failedIndex: number;
    };

export interface AgentBlueprintSummary {
  version: number;
  nodeCount: number;
  annotationCount: number;
  edgeCount: number;
  nodes: Array<{
    id: string;
    title: string;
    category?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    rev: number;
    hasScript: boolean;
    varKeys: string[];
  }>;
  annotations: Array<{
    id: string;
    kind: AnnotationKind;
    text: string;
    imageUrl?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    bgColor?: string;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
    bidirectional?: boolean;
  }>;
}

const MAX_OPS_PER_BATCH = 50;

function validateLeafBlockSafety(block: unknown): string | null {
  if (!block || typeof block !== 'object') return 'blocks 中包含非法元素';
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'image':
      if (typeof b.url === 'string' && b.url.trim() && !isSafeImageUrl(b.url)) {
        return `image 积木包含不安全的 url：${b.url}`;
      }
      break;
    case 'video':
      if (typeof b.url === 'string' && b.url.trim() && !isSafeVideoUrl(b.url)) {
        return `video 积木包含不安全的 url：${b.url}`;
      }
      if (typeof b.poster === 'string' && b.poster.trim() && !isSafeImageUrl(b.poster)) {
        return `video 积木包含不安全的 poster：${b.poster}`;
      }
      break;
    case 'pdf':
      if (typeof b.url === 'string' && b.url.trim() && !isSafePdfUrl(b.url)) {
        return `pdf 积木包含不安全的 url：${b.url}`;
      }
      break;
    case 'api_poller':
      if (typeof b.url === 'string' && b.url.trim() && !isSafePollUrl(b.url)) {
        return `api_poller 积木包含不安全的 url：${b.url}`;
      }
      break;
    case 'image_button':
      for (const field of ['offImage', 'onImage', 'hoverImage', 'clickImage']) {
        const v = b[field];
        if (typeof v === 'string' && v.trim() && !isSafeImageUrl(v)) {
          return `image_button 积木包含不安全的 ${field}：${v}`;
        }
      }
      break;
    default:
      break;
  }
  return null;
}

function validateBlocksSafety(blocks: unknown[]): string | null {
  for (const item of blocks) {
    if (Array.isArray(item)) {
      for (const sub of item) {
        const err = validateLeafBlockSafety(sub);
        if (err) return err;
      }
    } else {
      const err = validateLeafBlockSafety(item);
      if (err) return err;
    }
  }
  return null;
}

function clampDim(val: unknown, fallback: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeId(raw: unknown, prefix: string, existing: Record<string, unknown>): string {
  const cleaned =
    typeof raw === 'string'
      ? raw
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 64)
      : '';
  if (cleaned && !(cleaned in existing)) return cleaned;
  let seq = 1;
  while (true) {
    const candidate = `${prefix}-${Date.now().toString(36)}-${seq}`;
    if (!(candidate in existing)) return candidate;
    seq += 1;
  }
}

export function normalizeAgentBlueprint(raw: unknown): BaseBlueprint {
  if (raw && typeof raw === 'object') {
    const bp = raw as Partial<BaseBlueprint>;
    return {
      version: typeof bp.version === 'number' && Number.isFinite(bp.version) ? bp.version : 1,
      chunkSize: typeof bp.chunkSize === 'number' && Number.isFinite(bp.chunkSize) ? bp.chunkSize : 512,
      nodes: bp.nodes && typeof bp.nodes === 'object' ? JSON.parse(JSON.stringify(bp.nodes)) : {},
      annotations:
        bp.annotations && typeof bp.annotations === 'object' ? JSON.parse(JSON.stringify(bp.annotations)) : {},
      edges: bp.edges && typeof bp.edges === 'object' ? JSON.parse(JSON.stringify(bp.edges)) : {},
    };
  }
  return { version: 1, chunkSize: 512, nodes: {}, annotations: {}, edges: {} };
}

function collectBoxes(bp: BaseBlueprint): RectBox[] {
  const boxes: RectBox[] = [];
  for (const n of Object.values(bp.nodes)) {
    boxes.push({ x: n.x, y: n.y, width: n.width, height: n.height });
  }
  return boxes;
}

/** 面向 LLM 的紧凑房间状态摘要（避免将冗长脚本/内容块全量塞进上下文）。 */
export function summarizeBlueprintForAgent(raw: unknown): AgentBlueprintSummary {
  const bp = normalizeAgentBlueprint(raw);
  const nodes = Object.values(bp.nodes).map((n) => ({
    id: n.id,
    title: n.title,
    category: n.category,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    color: n.color,
    rev: n.rev,
    hasScript: Boolean(n.script && n.script.trim()),
    varKeys: Object.keys(n.defaultVars || {}),
  }));
  const annotations = Object.values(bp.annotations).map((a) => ({
    id: a.id,
    kind: a.kind,
    text: a.text,
    imageUrl: a.imageUrl,
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    bgColor: a.bgColor,
  }));
  const edges = Object.values(bp.edges).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    bidirectional: e.bidirectional,
  }));
  return {
    version: bp.version,
    nodeCount: nodes.length,
    annotationCount: annotations.length,
    edgeCount: edges.length,
    nodes,
    annotations,
    edges,
  };
}

/** 列出所有可供 Agent 通过 create_from_template 直接实例化的内置模板。 */
export function listAgentTemplates() {
  return BUILTIN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    kind: t.kind,
    description: t.description,
  }));
}

export function applyAgentOperations(
  base: unknown,
  ops: unknown,
  opts?: { actor?: string; maxOps?: number }
): ApplyAgentOpsResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: 'ops 必须是非空数组', failedIndex: 0 };
  }
  const maxOps = Math.max(1, Math.min(200, opts?.maxOps ?? MAX_OPS_PER_BATCH));
  if (ops.length > maxOps) {
    return { ok: false, error: `单次批量操作不能超过 ${maxOps} 条`, failedIndex: maxOps };
  }

  const actor = (opts?.actor || 'agent').trim().slice(0, 48) || 'agent';
  const next = normalizeAgentBlueprint(base);
  const results: AgentOpItemResult[] = [];

  for (let i = 0; i < ops.length; i++) {
    const rawOp = ops[i];
    if (!rawOp || typeof rawOp !== 'object' || typeof (rawOp as { op?: unknown }).op !== 'string') {
      return { ok: false, error: `第 ${i} 条操作缺少合法的 op 字段`, failedIndex: i };
    }
    const item = rawOp as AgentOperation;

    switch (item.op) {
      case 'create_from_template': {
        const tpl = BUILTIN_TEMPLATES.find((t) => t.id === item.templateId);
        if (!tpl) {
          return {
            ok: false,
            error: `未找到内置模板：${String(item.templateId || '')}`,
            failedIndex: i,
          };
        }
        if (tpl.kind === 'node' && tpl.nodePreset) {
          const preset = JSON.parse(JSON.stringify(tpl.nodePreset)) as typeof tpl.nodePreset;
          if (preset.script && preset.script.trim()) {
            const check = validateScriptSafety(preset.script);
            if (!check.ok) {
              return { ok: false, error: `模板脚本安全校验未通过：${check.reason}`, failedIndex: i };
            }
          }
          const width = clampDim(item.width, preset.width || 320, 140, 1600);
          const height = clampDim(item.height, preset.height || 220, 80, 1400);
          let x = Number(item.x);
          let y = Number(item.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const placed = findNonOverlappingPosition({ x: 120, y: 120, width, height }, collectBoxes(next));
            x = placed.x;
            y = placed.y;
          }
          const id = sanitizeId(item.id, tpl.id, next.nodes);
          const mergedVars = {
            ...(preset.defaultVars || {}),
            ...(item.defaultVars && typeof item.defaultVars === 'object'
              ? JSON.parse(JSON.stringify(item.defaultVars))
              : {}),
          };
          const node: BlueprintNode = {
            ...preset,
            id,
            x: Math.round(x),
            y: Math.round(y),
            width,
            height,
            title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 120) : preset.title,
            body: typeof item.body === 'string' ? item.body : preset.body,
            color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : preset.color,
            defaultVars: mergedVars,
            rev: 1,
            cid: actor,
          };
          next.nodes[id] = node;
          results.push({ index: i, op: item.op, id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height } });
        } else if (tpl.kind === 'annotation' && tpl.annotationPreset) {
          const preset = JSON.parse(JSON.stringify(tpl.annotationPreset)) as typeof tpl.annotationPreset;
          const finalImageUrl = item.imageUrl !== undefined ? item.imageUrl : preset.imageUrl;
          if (preset.kind === 'image' && finalImageUrl && !isSafeImageUrl(finalImageUrl)) {
            return { ok: false, error: 'create_from_template(annotation/image) 提供的 imageUrl 不安全', failedIndex: i };
          }
          const width = clampDim(item.width, preset.width || 420, 80, 3200);
          const height = clampDim(item.height, preset.height || 140, 40, 2400);
          let x = Number(item.x);
          let y = Number(item.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const placed = findNonOverlappingPosition({ x: 80, y: 80, width, height }, collectBoxes(next));
            x = placed.x;
            y = placed.y;
          }
          const id = sanitizeId(item.id, tpl.id, next.annotations);
          const ann: CanvasAnnotation = {
            ...preset,
            id,
            x: Math.round(x),
            y: Math.round(y),
            width,
            height,
            text: typeof item.text === 'string' ? item.text : preset.text,
            color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : preset.color,
            bgColor: typeof item.bgColor === 'string' && item.bgColor.trim() ? item.bgColor.trim() : preset.bgColor,
            bgOpacity:
              typeof item.bgOpacity === 'number' && Number.isFinite(item.bgOpacity)
                ? Math.max(0, Math.min(1, item.bgOpacity))
                : preset.bgOpacity,
            imageUrl: finalImageUrl,
            rev: 1,
            cid: actor,
          };
          next.annotations[id] = ann;
          results.push({ index: i, op: item.op, id, bounds: { x: ann.x, y: ann.y, width: ann.width, height: ann.height } });
        } else {
          return { ok: false, error: `模板 ${tpl.id} 缺少预设配置`, failedIndex: i };
        }
        break;
      }

      case 'create_widget': {
        if (typeof item.title !== 'string' || !item.title.trim()) {
          return { ok: false, error: 'create_widget 需要非空 title', failedIndex: i };
        }
        if (typeof item.script === 'string' && item.script.trim()) {
          const check = validateScriptSafety(item.script);
          if (!check.ok) {
            return { ok: false, error: `脚本安全校验未通过：${check.reason}`, failedIndex: i };
          }
        }
        const width = clampDim(item.width, 320, 140, 1600);
        const height = clampDim(item.height, 220, 80, 1400);
        let x = Number(item.x);
        let y = Number(item.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const placed = findNonOverlappingPosition({ x: 120, y: 120, width, height }, collectBoxes(next));
          x = placed.x;
          y = placed.y;
        }
        const id = sanitizeId(item.id, 'agent-node', next.nodes);
        const defaultVars: Record<string, unknown> =
          item.defaultVars && typeof item.defaultVars === 'object'
            ? JSON.parse(JSON.stringify(item.defaultVars))
            : {};
        if (Array.isArray(item.blocks)) {
          const blockErr = validateBlocksSafety(item.blocks);
          if (blockErr) return { ok: false, error: blockErr, failedIndex: i };
          defaultVars.contents = JSON.parse(JSON.stringify(item.blocks));
        }
        const node: BlueprintNode = {
          id,
          x: Math.round(x),
          y: Math.round(y),
          width,
          height,
          title: item.title.trim().slice(0, 120),
          body: typeof item.body === 'string' ? item.body : '',
          category: typeof item.category === 'string' ? item.category.trim().slice(0, 40) : 'Agent',
          color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : '#2563EB',
          script: typeof item.script === 'string' ? item.script : undefined,
          locked: Boolean(item.locked),
          defaultVars,
          buttons: Array.isArray(item.buttons) ? item.buttons : undefined,
          inputPorts: Array.isArray(item.inputPorts) ? item.inputPorts : undefined,
          outputPorts: Array.isArray(item.outputPorts) ? item.outputPorts : undefined,
          rev: 1,
          cid: actor,
        };
        next.nodes[id] = node;
        results.push({ index: i, op: item.op, id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height } });
        break;
      }

      case 'update_widget': {
        const target = typeof item.id === 'string' ? next.nodes[item.id] : undefined;
        if (!target) {
          return { ok: false, error: `未找到控件节点：${String(item.id || '')}`, failedIndex: i };
        }
        if (typeof item.script === 'string' && item.script.trim()) {
          const check = validateScriptSafety(item.script);
          if (!check.ok) {
            return { ok: false, error: `脚本安全校验未通过：${check.reason}`, failedIndex: i };
          }
        }
        const nextVars: Record<string, unknown> =
          item.defaultVars && typeof item.defaultVars === 'object'
            ? item.mergeVars === false
              ? JSON.parse(JSON.stringify(item.defaultVars))
              : { ...(target.defaultVars || {}), ...JSON.parse(JSON.stringify(item.defaultVars)) }
            : { ...(target.defaultVars || {}) };
        if (Array.isArray(item.blocks)) {
          const blockErr = validateBlocksSafety(item.blocks);
          if (blockErr) return { ok: false, error: blockErr, failedIndex: i };
          nextVars.contents = JSON.parse(JSON.stringify(item.blocks));
        }
        const updated: BlueprintNode = {
          ...target,
          title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 120) : target.title,
          body: typeof item.body === 'string' ? item.body : target.body,
          category: typeof item.category === 'string' ? item.category.trim().slice(0, 40) : target.category,
          color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : target.color,
          x: Number.isFinite(Number(item.x)) ? Math.round(Number(item.x)) : target.x,
          y: Number.isFinite(Number(item.y)) ? Math.round(Number(item.y)) : target.y,
          width: item.width !== undefined ? clampDim(item.width, target.width, 140, 1600) : target.width,
          height: item.height !== undefined ? clampDim(item.height, target.height, 80, 1400) : target.height,
          script: item.script !== undefined ? item.script : target.script,
          locked: item.locked !== undefined ? Boolean(item.locked) : target.locked,
          defaultVars: nextVars,
          buttons: Array.isArray(item.buttons) ? item.buttons : target.buttons,
          inputPorts: Array.isArray(item.inputPorts) ? item.inputPorts : target.inputPorts,
          outputPorts: Array.isArray(item.outputPorts) ? item.outputPorts : target.outputPorts,
          rev: (target.rev || 0) + 1,
          cid: actor,
        };
        next.nodes[target.id] = updated;
        results.push({ index: i, op: item.op, id: target.id, bounds: { x: updated.x, y: updated.y, width: updated.width, height: updated.height } });
        break;
      }

      case 'delete_widget': {
        if (typeof item.id !== 'string' || !next.nodes[item.id]) {
          return { ok: false, error: `未找到待删除控件节点：${String(item.id || '')}`, failedIndex: i };
        }
        delete next.nodes[item.id];
        for (const [eid, edge] of Object.entries(next.edges)) {
          if (edge.source === item.id || edge.target === item.id) {
            delete next.edges[eid];
          }
        }
        results.push({ index: i, op: item.op, id: item.id });
        break;
      }

      case 'create_annotation': {
        const kind: AnnotationKind = item.kind === 'image' ? 'image' : 'text';
        if (kind === 'image') {
          if (typeof item.imageUrl !== 'string' || !isSafeImageUrl(item.imageUrl)) {
            return { ok: false, error: 'create_annotation(image) 需要合法安全的 imageUrl', failedIndex: i };
          }
        }
        const width = clampDim(item.width, kind === 'image' ? 480 : 420, 80, 3200);
        const height = clampDim(item.height, kind === 'image' ? 320 : 120, 40, 2400);
        let x = Number(item.x);
        let y = Number(item.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const placed = findNonOverlappingPosition({ x: 80, y: 80, width, height }, collectBoxes(next));
          x = placed.x;
          y = placed.y;
        }
        const id = sanitizeId(item.id, 'agent-ann', next.annotations);
        const ann: CanvasAnnotation = {
          id,
          kind,
          x: Math.round(x),
          y: Math.round(y),
          width,
          height,
          text: typeof item.text === 'string' ? item.text : '',
          fontSize: clampDim(item.fontSize, 20, 12, 96),
          color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : '#1E293B',
          bgColor: typeof item.bgColor === 'string' && item.bgColor.trim() ? item.bgColor.trim() : '#EFF6FF',
          bgOpacity:
            typeof item.bgOpacity === 'number' && Number.isFinite(item.bgOpacity)
              ? Math.max(0, Math.min(1, item.bgOpacity))
              : 0.45,
          imageUrl: kind === 'image' ? item.imageUrl : undefined,
          weight: item.weight === 'bold' ? 'bold' : 'normal',
          nonInteractive: item.nonInteractive !== false,
          rev: 1,
          cid: actor,
        };
        next.annotations[id] = ann;
        results.push({ index: i, op: item.op, id, bounds: { x: ann.x, y: ann.y, width: ann.width, height: ann.height } });
        break;
      }

      case 'update_annotation': {
        const target = typeof item.id === 'string' ? next.annotations[item.id] : undefined;
        if (!target) {
          return { ok: false, error: `未找到背景注释层：${String(item.id || '')}`, failedIndex: i };
        }
        if (item.imageUrl !== undefined && item.imageUrl !== '' && !isSafeImageUrl(item.imageUrl)) {
          return { ok: false, error: 'update_annotation 提供的 imageUrl 不安全', failedIndex: i };
        }
        const updatedAnn: CanvasAnnotation = {
          ...target,
          text: typeof item.text === 'string' ? item.text : target.text,
          imageUrl: item.imageUrl !== undefined ? item.imageUrl : target.imageUrl,
          x: Number.isFinite(Number(item.x)) ? Math.round(Number(item.x)) : target.x,
          y: Number.isFinite(Number(item.y)) ? Math.round(Number(item.y)) : target.y,
          width: item.width !== undefined ? clampDim(item.width, target.width, 80, 3200) : target.width,
          height: item.height !== undefined ? clampDim(item.height, target.height, 40, 2400) : target.height,
          fontSize: item.fontSize !== undefined ? clampDim(item.fontSize, target.fontSize, 12, 96) : target.fontSize,
          color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : target.color,
          bgColor: typeof item.bgColor === 'string' && item.bgColor.trim() ? item.bgColor.trim() : target.bgColor,
          bgOpacity:
            typeof item.bgOpacity === 'number' && Number.isFinite(item.bgOpacity)
              ? Math.max(0, Math.min(1, item.bgOpacity))
              : target.bgOpacity,
          weight: item.weight !== undefined ? (item.weight === 'bold' ? 'bold' : 'normal') : target.weight,
          nonInteractive: item.nonInteractive !== undefined ? Boolean(item.nonInteractive) : target.nonInteractive,
          rev: (target.rev || 0) + 1,
          cid: actor,
        };
        next.annotations[target.id] = updatedAnn;
        results.push({ index: i, op: item.op, id: target.id, bounds: { x: updatedAnn.x, y: updatedAnn.y, width: updatedAnn.width, height: updatedAnn.height } });
        break;
      }

      case 'delete_annotation': {
        if (typeof item.id !== 'string' || !next.annotations[item.id]) {
          return { ok: false, error: `未找到待删除背景注释层：${String(item.id || '')}`, failedIndex: i };
        }
        delete next.annotations[item.id];
        results.push({ index: i, op: item.op, id: item.id });
        break;
      }

      case 'connect_edge': {
        if (!item.source || !next.nodes[item.source]) {
          return { ok: false, error: `连线起点节点不存在：${String(item.source || '')}`, failedIndex: i };
        }
        if (!item.target || !next.nodes[item.target]) {
          return { ok: false, error: `连线终点节点不存在：${String(item.target || '')}`, failedIndex: i };
        }
        const id = sanitizeId(item.id, 'agent-edge', next.edges);
        const edge: BlueprintEdge = {
          id,
          source: item.source,
          target: item.target,
          sourceHandle: typeof item.sourceHandle === 'string' ? item.sourceHandle : undefined,
          targetHandle: typeof item.targetHandle === 'string' ? item.targetHandle : undefined,
          label: typeof item.label === 'string' ? item.label.slice(0, 60) : undefined,
          color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : undefined,
          dashed: Boolean(item.dashed),
          bidirectional: Boolean(item.bidirectional),
          rev: 1,
          cid: actor,
        };
        next.edges[id] = edge;
        results.push({ index: i, op: item.op, id });
        break;
      }

      case 'delete_edge': {
        if (typeof item.id !== 'string' || !next.edges[item.id]) {
          return { ok: false, error: `未找到待删除连线：${String(item.id || '')}`, failedIndex: i };
        }
        delete next.edges[item.id];
        results.push({ index: i, op: item.op, id: item.id });
        break;
      }

      default:
        return {
          ok: false,
          error: `不支持的操作类型：${String((item as { op?: unknown }).op)}`,
          failedIndex: i,
        };
    }
  }

  next.version = (next.version || 0) + 1;
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.op] = (acc[r.op] || 0) + 1;
    return acc;
  }, {});
  const summary =
    `Agent(${actor}) 执行 ${results.length} 项操作：` +
    Object.entries(counts)
      .map(([k, v]) => `${k}×${v}`)
      .join(', ');

  return { ok: true, blueprint: next, results, summary };
}

/**
 * 供 OpenAI / Gemini / MCP Agent 直接注册的标准工具描述（JSON Schema）。
 */
export function getAgentToolSchema() {
  return [
    {
      name: 'atlas_inspect_room',
      description:
        '读取 Atlas Hybrid Canvas 指定房间的实时 revision、全部控件/背景/连线摘要以及可用模板清单（先同步 WS 内存态，避免读到陈旧快照）。',
      parameters: {
        type: 'object',
        properties: {
          room: { type: 'string', description: '房间路径，如 "team/design"，默认 "atlas-main"' },
          full: { type: 'boolean', description: '为 true 时同时返回完整 blueprint JSON' },
        },
      },
    },
    {
      name: 'atlas_canvas_ops',
      description:
        '在 Atlas Hybrid Canvas 指定房间内原子批量创建、修改或删除控件（支持内置模板与结构化积木）、背景注释/插图与连线，支持 expectedRevision 乐观锁与 dryRun 预演。',
      parameters: {
        type: 'object',
        required: ['ops'],
        properties: {
          room: { type: 'string', description: '房间路径，如 "team/design"' },
          actor: { type: 'string', description: 'Agent 标识，写入修改日志便于审计与回档' },
          summary: { type: 'string', description: '可选的人类可读变更摘要' },
          expectedRevision: {
            type: 'number',
            description: '可选乐观锁：若房间当前 revision 与此值不符则返回 409 Conflict',
          },
          dryRun: {
            type: 'boolean',
            description: '为 true 时仅校验并计算自动布局坐标，不落盘、不广播',
          },
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              required: ['op'],
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'create_from_template',
                    'create_widget',
                    'update_widget',
                    'delete_widget',
                    'create_annotation',
                    'update_annotation',
                    'delete_annotation',
                    'connect_edge',
                    'delete_edge',
                  ],
                },
                templateId: { type: 'string' },
                id: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                kind: { type: 'string', enum: ['text', 'image'] },
                text: { type: 'string' },
                imageUrl: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                color: { type: 'string' },
                bgColor: { type: 'string' },
                bgOpacity: { type: 'number' },
                script: { type: 'string' },
                blocks: { type: 'array' },
                defaultVars: { type: 'object' },
                mergeVars: { type: 'boolean' },
                source: { type: 'string' },
                target: { type: 'string' },
                bidirectional: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  ];
}
