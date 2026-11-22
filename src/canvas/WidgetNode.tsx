import { memo, useEffect } from 'react';
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Copy, Globe, Play, RotateCcw, Settings2, Trash2 } from 'lucide-react';
import type { EffectiveBlueprintNode, NodePortSpec, WidgetButtonSpec } from '../core/types';

export interface WidgetNodeData extends Record<string, unknown> {
  entity: EffectiveBlueprintNode;
  onRunButton: (nodeId: string, btn: WidgetButtonSpec) => void;
  onResetLocal: (nodeId: string) => void;
  onEditTitle: (nodeId: string, nextTitle: string) => void;
  onEditBody: (nodeId: string, nextBody: string) => void;
  onResizeNode: (nodeId: string, width: number, height: number) => void;
  onOpenInspector: (nodeId: string) => void;
  onDuplicateNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  busyButtonKey: string | null;
}

const DEFAULT_INPUT_PORTS: NodePortSpec[] = [
  { id: 'in-1', label: '入口 1' },
  { id: 'in-2', label: '入口 2' },
];

const DEFAULT_OUTPUT_PORTS: NodePortSpec[] = [
  { id: 'out-1', label: '出口 1' },
];

const VARIANT_CLASSES: Record<string, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'bg-slate-100 text-slate-800 hover:bg-slate-200 border border-slate-200',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800',
  danger: 'bg-rose-700 text-white hover:bg-rose-800',
};

function WidgetNodeInner({ data, selected }: NodeProps) {
  const {
    entity,
    onRunButton,
    onResetLocal,
    onEditTitle,
    onEditBody,
    onResizeNode,
    onOpenInspector,
    onDuplicateNode,
    onDeleteNode,
    busyButtonKey,
  } = data as WidgetNodeData;

  const updateNodeInternals = useUpdateNodeInternals();
  const inputPorts = entity.inputPorts && entity.inputPorts.length > 0 ? entity.inputPorts : DEFAULT_INPUT_PORTS;
  const outputPorts = entity.outputPorts && entity.outputPorts.length > 0 ? entity.outputPorts : DEFAULT_OUTPUT_PORTS;
  const portSignature = `${inputPorts.map((p) => p.id).join(',')}|${outputPorts.map((p) => p.id).join(',')}`;

  // 端口增删后主动刷新 React Flow 内部 Handle 坐标缓存，防止连线错位
  useEffect(() => {
    updateNodeInternals(entity.id);
  }, [entity.id, portSignature, entity.width, entity.height, updateNodeInternals]);

  const varEntries = Object.entries(entity.effectiveVars || {});

  return (
    <div
      className={`group relative flex h-full w-full flex-col rounded-lg border bg-white/95 shadow-sm transition-shadow hover:shadow-md ${
        selected ? 'ring-2 ring-blue-500/40' : ''
      }`}
      style={{
        width: entity.width,
        minHeight: entity.height,
        borderColor: entity.color,
        borderTopWidth: 4,
      }}
    >
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={200}
        minHeight={120}
        lineClassName="!border-blue-500"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-blue-600 !bg-white"
        onResizeEnd={(_ev, params) => {
          onResizeNode(entity.id, Math.round(params.width), Math.round(params.height));
        }}
      />

      {/* 多个独立入箭头端口（左侧等距排布） */}
      {inputPorts.map((port, idx) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          title={port.label || port.id}
          style={{ top: `${((idx + 1) / (inputPorts.length + 1)) * 100}%` }}
          className="!h-3 !w-3 !border-2 !border-white !bg-slate-600 hover:!bg-blue-600"
        />
      ))}

      {/* 多个独立出箭头端口（右侧等距排布） */}
      {outputPorts.map((port, idx) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          title={port.label || port.id}
          style={{ top: `${((idx + 1) / (outputPorts.length + 1)) * 100}%` }}
          className="!h-3 !w-3 !border-2 !border-white !bg-blue-600 hover:!bg-teal-600"
        />
      ))}

      {/* 顶栏：可直接改标题 + 右侧操作按钮 */}
      <div className="flex items-center justify-between gap-1.5 border-b border-slate-100 px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {entity.category && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white"
              style={{ backgroundColor: entity.color }}
            >
              {entity.category}
            </span>
          )}
          <input
            type="text"
            value={entity.title}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onEditTitle(entity.id, e.target.value)}
            className="nodrag nopan nowheel min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 text-xs font-bold text-slate-900 outline-none focus:bg-slate-100"
          />
        </div>

        <div className="nodrag nopan flex shrink-0 items-center gap-0.5">
          {(entity.hasLocalOverride || entity.hasRuntimeVars) && (
            <button
              type="button"
              title="此节点含个人本地修改或运行态 vars，点击还原为后端默认"
              onClick={(e) => {
                e.stopPropagation();
                onResetLocal(entity.id);
              }}
              className="flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
            >
              <RotateCcw className="h-3 w-3" />
              还原
            </button>
          )}
          <button
            type="button"
            title="编辑属性 / 端口 / 按钮 / 脚本"
            onClick={(e) => {
              e.stopPropagation();
              onOpenInspector(entity.id);
            }}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-700"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="复制控件"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicateNode(entity.id);
            }}
            className="hidden rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 group-hover:inline-flex"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="删除控件"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteNode(entity.id);
            }}
            className="hidden rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 group-hover:inline-flex"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 正文与交互区 */}
      <div className="flex flex-1 flex-col px-3 py-2">
        <textarea
          value={entity.body}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onEditBody(entity.id, e.target.value)}
          rows={3}
          placeholder="点击输入正文…"
          className="nodrag nopan nowheel w-full flex-1 resize-y rounded border border-transparent bg-transparent text-xs leading-relaxed text-slate-600 focus:border-slate-300 focus:bg-slate-50 focus:outline-none"
        />

        {varEntries.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {varEntries.map(([k, v]) => (
              <span
                key={k}
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-700"
              >
                {k}={typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            ))}
          </div>
        )}

        {entity.buttons && entity.buttons.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {entity.buttons.map((btn) => {
              const btnKey = `${entity.id}:${btn.id}`;
              const isBusy = busyButtonKey === btnKey;
              const cls = VARIANT_CLASSES[btn.variant ?? 'primary'] ?? VARIANT_CLASSES.primary;
              return (
                <button
                  key={btn.id}
                  type="button"
                  disabled={isBusy}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRunButton(entity.id, btn);
                  }}
                  className={`nodrag nopan inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium disabled:opacity-50 ${cls}`}
                >
                  {btn.actionType === 'proxy_http' ? (
                    <Globe className="h-3 w-3" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  {isBusy ? '执行中…' : btn.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const WidgetNode = memo(WidgetNodeInner);
