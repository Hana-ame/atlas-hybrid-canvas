/**
 * @file types.ts
 * @description Atlas Hybrid Canvas 全局核心数据模型定义。
 *
 * 严格区分四类核心概念：
 * 1. Chunk（512×512 空间分区）：底层空间哈希网格与离屏瓦片缓存单元；
 * 2. BlueprintNode（控件节点）：近/中景由 React Flow 渲染为原生 DOM，全景由底层瓦片接管；
 * 3. CanvasAnnotation（背景注释层）：分为「文本框（text）」与「等比插图（image）」两类，平时点击穿透；
 * 4. LocalOverlayState（个人本地叠加层）：运行时 vars、字段级节点补丁与脚本触发的背景覆盖，全量存 IndexedDB。
 */

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

export interface ContentPdfBlock {
  type: 'pdf';
  id: string;
  url?: string;
  page?: number;
  height?: number;
  useProxy?: boolean;
  bindUrl?: string;
  bindPage?: string;
  bindProxy?: string;
}

export interface ContentApiPollerBlock {
  type: 'api_poller';
  id: string;
  url?: string;
  method?: 'GET' | 'POST';
  intervalSec?: number;
  jsonPath?: string;
  useProxy?: boolean;
  enabled?: boolean;
  bindUrl?: string;
  bindMethod?: string;
  bindInterval?: string;
  bindJsonPath?: string;
  bindProxy?: string;
  bindEnabled?: string;
}

export interface ContentImageBlock {
  type: 'image';
  id: string;
  url?: string;
  caption?: string;
  fit?: 'contain' | 'cover';
  bindUrl?: string;
  bindCaption?: string;
  bindFit?: string;
}

export interface ContentVideoBlock {
  type: 'video';
  id: string;
  url?: string;
  poster?: string;
  loop?: boolean;
  muted?: boolean;
  bindUrl?: string;
  bindLoop?: string;
  bindMuted?: string;
}

export interface ContentSliderBlock {
  type: 'slider';
  id: string;
  bind?: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  unit?: string;
  showValue?: boolean;
  accentColor?: string;
  width?: number;
}

export interface ContentPad2DBlock {
  type: 'pad2d';
  id: string;
  label?: string;
  labelX?: string;
  labelY?: string;
  bindX?: string;
  bindY?: string;
  x?: number;
  y?: number;
  minX?: number;
  maxX?: number;
  stepX?: number;
  minY?: number;
  maxY?: number;
  stepY?: number;
  unitX?: string;
  unitY?: string;
  invertY?: boolean;
  height?: number;
  accentColor?: string;
}

export interface ContentImageButtonBlock {
  type: 'image_button';
  id: string;
  bind?: string;
  label?: string;
  toggle?: boolean;
  on?: boolean;
  offImage?: string;
  onImage?: string;
  hoverImage?: string;
  clickImage?: string;
  bindOffImage?: string;
  bindOnImage?: string;
  bindHoverImage?: string;
  bindClickImage?: string;
  width?: number;
  height?: number;
  disabled?: boolean;
  showStateBadge?: boolean;
}

export type ContentLeafBlock =
  | ContentTextBlock
  | ContentButtonBlock
  | ContentInputBlock
  | ContentPdfBlock
  | ContentApiPollerBlock
  | ContentImageBlock
  | ContentVideoBlock
  | ContentSliderBlock
  | ContentPad2DBlock
  | ContentImageButtonBlock;
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

export interface EdgeControlPoint {
  x: number;
  y: number;
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
  /** 是否为单线双向连线（双头箭头 <——>，任一端变更自动通知对端） */
  bidirectional?: boolean;
  /** 可选自定义路径控制点（按顺序平滑穿过，避让节点卡片） */
  controlPoints?: EdgeControlPoint[];
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

export interface EdgeChannelState {
  msg?: unknown;
  flag?: boolean;
  seq?: number;
  updatedAt?: number;
  /** 脚本动态覆盖连线标签、名称、虚实线、颜色与线宽 */
  tag?: string;
  name?: string;
  dashed?: boolean;
  color?: string;
  width?: number;
}

export interface LocalOverlayState {
  runtimeVars: Record<string, Record<string, unknown>>;
  nodePatches: Record<string, LocalNodePatch>;
  annotationOverrides: Record<string, LocalAnnotationOverride>;
  edgeRuntime?: Record<string, EdgeChannelState>;
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
