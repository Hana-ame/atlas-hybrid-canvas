import { Handle, Position, type NodeProps } from '@xyflow/react';
import { RotateCcw, Play, Globe } from 'lucide-react';
import type { EffectiveBlueprintNode, WidgetButtonSpec } from '../core/types';

export interface WidgetNodeData extends Record<string, unknown> {
  entity: EffectiveBlueprintNode;
  onRunButton: (nodeId: string, btn: WidgetButtonSpec) => void;
  onResetLocal: (nodeId: string) => void;
  onEditBody: (nodeId: string, nextBody: string) => void;
  busyButtonKey: string | null;
}

export function WidgetNode({ data }: NodeProps) {
  const { entity, onRunButton, onResetLocal, onEditBody, busyButtonKey } = data as WidgetNodeData;
  const varEntries = Object.entries(entity.effectiveVars || {});

  return (
    <div
      className="rounded-lg border bg-white/95 shadow-sm transition-shadow hover:shadow-md"
      style={{
        width: entity.width,
        minHeight: entity.height,
        borderColor: entity.color,
        borderTopWidth: 4,
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-slate-400" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-slate-400" />

      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div className="min-w-0">
          {entity.category && (
            <span
              className="mr-1.5 inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white"
              style={{ backgroundColor: entity.color }}
            >
              {entity.category}
            </span>
          )}
          <span className="truncate text-xs font-bold text-slate-900">{entity.title}</span>
        </div>

        {(entity.hasLocalOverride || entity.hasRuntimeVars) && (
          <button
            type="button"
            title="重置此节点为后端默认值"
            onClick={(e) => {
              e.stopPropagation();
              onResetLocal(entity.id);
            }}
            className="nodrag flex shrink-0 items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
          >
            <RotateCcw className="h-3 w-3" />
            本地态
          </button>
        )}
      </div>

      <div className="px-3 py-2">
        <textarea
          value={entity.body}
          onChange={(e) => onEditBody(entity.id, e.target.value)}
          rows={2}
          className="nodrag w-full resize-none rounded border border-transparent bg-transparent text-xs leading-relaxed text-slate-600 focus:border-slate-300 focus:bg-slate-50 focus:outline-none"
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
              return (
                <button
                  key={btn.id}
                  type="button"
                  disabled={isBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRunButton(entity.id, btn);
                  }}
                  className="nodrag inline-flex items-center gap-1 rounded bg-slate-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
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
