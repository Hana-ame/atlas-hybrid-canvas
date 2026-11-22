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
  /** 按钮点击执行的轻量脚本或声明式动作 */
  actionType: 'script' | 'proxy_http';
  code?: string;
  proxyUrl?: string;
  proxyMethod?: 'GET' | 'POST';
}

/**
 * 权威底座中的蓝图节点（会被 React Flow 近景渲染，也会被 Canvas 远景瓦片烘焙）
 */
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
  /** 后端权威默认变量（只读基线，用户本地修改不会污染此处） */
  defaultVars: Record<string, unknown>;
  buttons?: WidgetButtonSpec[];
  /** CRDT 协同版本字段（兼容 room-go/store.go） */
  rev: number;
  cid: string;
}

/**
 * 画板级不可交互背景注释文本（直接烘焙进 512x512 离屏瓦片，平时完全穿透不拦截鼠标）
 */
export interface CanvasAnnotation {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
  color: string;
  weight?: 'normal' | 'bold';
  /** true = 平时完全不可交互（点击穿透）；仅在开启“注释编辑模式”时才可编辑 */
  nonInteractive: boolean;
  rev: number;
  cid: string;
}

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
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
 * 按字段级稀疏 Patch 存储，避免覆盖后端新发布的节点架构
 */
export interface LocalNodePatch {
  title?: string;
  body?: string;
  x?: number;
  y?: number;
  color?: string;
}

export interface LocalOverlayState {
  /** 每个节点的运行时变量（按钮执行、接口返回、个人调试值） */
  runtimeVars: Record<string, Record<string, unknown>>;
  /** 个人对节点的字段级局部修改补丁 */
  nodePatches: Record<string, LocalNodePatch>;
  /** 远端同步脚本的信任白名单（按 nodeId:buttonId 记录） */
  trustedRemoteScripts: Record<string, boolean>;
}

export interface EffectiveBlueprintNode extends BlueprintNode {
  effectiveVars: Record<string, unknown>;
  hasLocalOverride: boolean;
  hasRuntimeVars: boolean;
}
