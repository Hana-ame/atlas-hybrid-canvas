export type ChunkKey = `${number},${number}`;

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
}

export type LODLevel = 'macro' | 'meso' | 'micro';

export interface WidgetButtonSpec {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  actionType: 'script' | 'proxy_http';
  code?: string;
  proxyUrl?: string;
  proxyMethod?: 'GET' | 'POST';
}

export interface NodePortSpec {
  id: string;
  label?: string;
}

export interface BlueprintNode {
  /** 可配置多个入箭头端口（默认在左侧均匀排布） */
  inputPorts?: NodePortSpec[];
  /** 可配置多个出箭头端口（默认在右侧均匀排布） */
  outputPorts?: NodePortSpec[];
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  body: string;
  category?: string;
  color: string;
  defaultVars: Record<string, unknown>;
  buttons?: WidgetButtonSpec[];
  rev: number;
  cid: string;
}

export interface CanvasAnnotation {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
  color: string;
  weight?: 'normal' | 'bold';
  nonInteractive: boolean;
  rev: number;
  cid: string;
}

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  color?: string;
  dashed?: boolean;
  rev: number;
  cid: string;
}

export interface BaseBlueprint {
  version: number;
  chunkSize: number;
  nodes: Record<string, BlueprintNode>;
  annotations: Record<string, CanvasAnnotation>;
  edges: Record<string, BlueprintEdge>;
}

/**
 * 个人本地叠加层（仅保存在当前浏览器 IndexedDB）
 */
export interface LocalNodePatch {
  title?: string;
  body?: string;
  category?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  buttons?: WidgetButtonSpec[];
  inputPorts?: NodePortSpec[];
  outputPorts?: NodePortSpec[];
}

export interface LocalOverlayState {
  runtimeVars: Record<string, Record<string, unknown>>;
  nodePatches: Record<string, LocalNodePatch>;
  trustedRemoteScripts: Record<string, boolean>;
}

export interface EffectiveBlueprintNode extends BlueprintNode {
  effectiveVars: Record<string, unknown>;
  hasLocalOverride: boolean;
  hasRuntimeVars: boolean;
}

export type TemplateGroup = '知识地图' | '策划与世界观' | '工程与运维' | '注释与基础' | '我的模板';

export interface BlueprintTemplate {
  id: string;
  name: string;
  description: string;
  group: TemplateGroup;
  kind: 'node' | 'annotation';
  color: string;
  /** kind === 'node' 时的预设 */
  nodePreset?: Omit<BlueprintNode, 'id' | 'x' | 'y' | 'rev' | 'cid'>;
  /** kind === 'annotation' 时的预设 */
  annotationPreset?: Omit<CanvasAnnotation, 'id' | 'x' | 'y' | 'rev' | 'cid'>;
}
