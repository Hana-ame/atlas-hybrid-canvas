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

export interface NodePortSpec {
  id: string;
  label?: string;
}

export interface WidgetButtonSpec {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  actionType: 'script' | 'proxy_http';
  code?: string;
  proxyUrl?: string;
  proxyMethod?: 'GET' | 'POST';
}

export interface ContentTextBlock {
  type: 'text';
  text: string;
  align?: 'left' | 'center' | 'right';
  color?: string;
  fontSize?: number;
  bold?: boolean;
}

export interface ContentButtonBlock {
  type: 'button';
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  width?: number;
  height?: number;
  disabled?: boolean;
}

export interface ContentInputBlock {
  type: 'input' | 'textarea';
  id: string;
  bind?: string;
  placeholder?: string;
  multiline?: boolean;
  width?: number;
  height?: number;
}

export type ContentLeafBlock = ContentTextBlock | ContentButtonBlock | ContentInputBlock;
export type ContentFlowItem = ContentLeafBlock | ContentLeafBlock[];

export interface BlueprintNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  body: string;
  category?: string;
  color: string;
  /** 统一脚本：可动态产出 vars.contents（含文本/按钮/输入框/行排布），支持 on/onSubmit/emit/broadcast/widgets/canvas */
  script?: string;
  /** 锁定后不可拖拽，但内部按钮与输入框仍可正常交互 */
  locked?: boolean;
  defaultVars: Record<string, unknown>;
  buttons?: WidgetButtonSpec[];
  inputPorts?: NodePortSpec[];
  outputPorts?: NodePortSpec[];
  rev: number;
  cid: string;
}

export type AnnotationKind = 'text' | 'image';

export interface CanvasAnnotation {
  id: string;
  kind: AnnotationKind;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
  bgColor?: string;
  bgOpacity?: number;
  imageUrl?: string;
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

export interface LocalNodePatch {
  title?: string;
  body?: string;
  category?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  script?: string;
  locked?: boolean;
  buttons?: WidgetButtonSpec[];
  inputPorts?: NodePortSpec[];
  outputPorts?: NodePortSpec[];
}

export interface LocalAnnotationOverride {
  text?: string;
  color?: string;
  bgColor?: string;
  bgOpacity?: number;
  imageUrl?: string;
}

export interface LocalOverlayState {
  runtimeVars: Record<string, Record<string, unknown>>;
  nodePatches: Record<string, LocalNodePatch>;
  annotationOverrides: Record<string, LocalAnnotationOverride>;
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
  nodePreset?: Omit<BlueprintNode, 'id' | 'x' | 'y' | 'rev' | 'cid'>;
  annotationPreset?: Omit<CanvasAnnotation, 'id' | 'x' | 'y' | 'rev' | 'cid'>;
}
