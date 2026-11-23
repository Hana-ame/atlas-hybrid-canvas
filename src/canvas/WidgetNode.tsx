/**
 * @file WidgetNode.tsx
 * @description React Flow 控件节点组件。
 * 交互规范：
 * - 默认按住卡片任意非按钮区域均可直接拖动，双击标题或正文进入原地编辑（Esc/失焦退出）；
 * - 支持多入/出箭头端口动态排布（变动后自动调用 useUpdateNodeInternals 刷新锚点）；
 * - 当 entity.script 产出 vars.contents 时，自动切换为声明式流式 UI（文本、按钮、原生输入框与水平行）。
 */

import { memo, useEffect, useState } from 'react';
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Copy, Globe, Lock, Play, RotateCcw, Settings2, Trash2, Unlock } from 'lucide-react';
import { parseTaskLine, toggleTaskLine } from '../core/taskList';
import type {
  ContentFlowItem,
  ContentLeafBlock,
  EffectiveBlueprintNode,
  NodePortSpec,
  WidgetButtonSpec,
} from '../core/types';

export interface WidgetNodeData extends Record<string, unknown> {
  entity: EffectiveBlueprintNode;
  onRunButton: (nodeId: string, btn: WidgetButtonSpec) => void;
  onRunScriptClick: (nodeId: string, buttonId: string) => void;
  onScriptInputChange: (nodeId: string, bindKey: string, value: string) => void;
  onScriptInputSubmit: (nodeId: string, inputId: string, value: string) => void;
  onToggleLock: (nodeId: string) => void;
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
    onRunScriptClick,
    onScriptInputChange,
    onScriptInputSubmit,
    onToggleLock,
    onResetLocal,
    onEditTitle,
    onEditBody,
    onResizeNode,
    onOpenInspector,
    onDuplicateNode,
    onDeleteNode,
    busyButtonKey,
  } = data as WidgetNodeData;

  // 默认单击/按住整卡可拖动，双击标题或正文才进入编辑态！
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingBody, setEditingBody] = useState(false);

  const updateNodeInternals = useUpdateNodeInternals();
  const inputPorts = entity.inputPorts !== undefined ? entity.inputPorts : DEFAULT_INPUT_PORTS;
  const outputPorts = entity.outputPorts !== undefined ? entity.outputPorts : DEFAULT_OUTPUT_PORTS;
  const portSignature = `${inputPorts.map((p) => p.id).join(',')}|${outputPorts.map((p) => p.id).join(',')}`;

  useEffect(() => {
    updateNodeInternals(entity.id);
  }, [entity.id, portSignature, entity.width, entity.height, updateNodeInternals]);

  // 取消选中时自动退出编辑态
  useEffect(() => {
    if (!selected) {
      setEditingTitle(false);
      setEditingBody(false);
    }
  }, [selected]);

  const rawContents = entity.effectiveVars?.contents;
  const flowItems: ContentFlowItem[] = Array.isArray(rawContents) ? (rawContents as ContentFlowItem[]) : [];
  const hasScriptContents = flowItems.length > 0;
  const varEntries = Object.entries(entity.effectiveVars || {}).filter(([k]) => k !== 'contents');

  const renderLeafBlock = (block: ContentLeafBlock, idx: number, inRow: boolean) => {
    if (!block || typeof block !== 'object') return null;

    if (block.type === 'text') {
      return (
        <div
          key={`txt-${idx}`}
          className={`select-none ${inRow ? 'flex-1' : 'w-full'}`}
          style={{
            textAlign: block.align ?? 'left',
            color: block.color || '#334155',
            fontSize: block.fontSize ?? 12,
            fontWeight: block.bold ? 700 : 400,
            lineHeight: 1.45,
          }}
        >
          {String(block.text ?? '')}
        </div>
      );
    }

    if (block.type === 'button') {
      const btnKey = `${entity.id}:script:${block.id}`;
      const isBusy = busyButtonKey === btnKey;
      const cls = VARIANT_CLASSES[block.variant ?? 'primary'] ?? VARIANT_CLASSES.primary;
      return (
        <button
          key={`btn-${block.id}-${idx}`}
          type="button"
          disabled={Boolean(block.disabled) || isBusy}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRunScriptClick(entity.id, block.id);
          }}
          style={block.width ? { width: block.width } : undefined}
          className={`nodrag nopan inline-flex items-center justify-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
            inRow && !block.width ? 'flex-1' : ''
          } ${cls}`}
        >
          <Play className="h-3 w-3 shrink-0" />
          <span className="truncate">{isBusy ? '执行中…' : block.label}</span>
        </button>
      );
    }

    if (block.type === 'input' || block.type === 'textarea') {
      const bindKey = block.bind || block.id;
      const val = entity.effectiveVars?.[bindKey] !== undefined ? String(entity.effectiveVars[bindKey]) : '';
      const isMultiline = block.type === 'textarea' || Boolean(block.multiline);
      if (isMultiline) {
        return (
          <textarea
            key={`inp-${block.id}-${idx}`}
            value={val}
            rows={2}
            placeholder={block.placeholder || '输入内容…'}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onScriptInputChange(entity.id, bindKey, e.target.value)}
            className={`nodrag nopan nowheel rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-blue-500 ${
              inRow ? 'flex-1' : 'w-full'
            }`}
          />
        );
      }
      return (
        <input
          key={`inp-${block.id}-${idx}`}
          type="text"
          value={val}
          placeholder={block.placeholder || '输入文字按回车提交…'}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onScriptInputChange(entity.id, bindKey, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onScriptInputSubmit(entity.id, block.id, val);
            }
          }}
          className={`nodrag nopan nowheel rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-500 ${
            inRow ? 'min-w-0 flex-1' : 'w-full'
          }`}
        />
      );
    }

    return null;
  };

  return (
    <div
      className={`group relative flex h-full w-full flex-col rounded-lg border bg-white/95 shadow-sm transition-shadow hover:shadow-md ${
        entity.locked ? 'cursor-default ring-1 ring-slate-300' : 'cursor-grab active:cursor-grabbing'
      } ${selected ? 'ring-2 ring-blue-500/40' : ''}`}
      style={{
        width: entity.width,
        minHeight: entity.height,
        borderColor: entity.color,
        borderTopWidth: 4,
      }}
    >
      <NodeResizer
        isVisible={Boolean(selected) && !entity.locked}
        minWidth={220}
        minHeight={120}
        lineClassName="!border-blue-500"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-blue-600 !bg-white"
        onResizeEnd={(_ev, params) => {
          onResizeNode(entity.id, Math.round(params.width), Math.round(params.height));
        }}
      />

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

      {/* 顶栏：默认整栏可拖动，双击标题进入编辑 */}
      <div className="flex items-center justify-between gap-1.5 border-b border-slate-100 px-2.5 py-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingTitle(true);
          }}
          title="按住拖动 · 双击编辑标题"
        >
          {entity.category && (
            <span
              className="shrink-0 select-none rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white"
              style={{ backgroundColor: entity.color }}
            >
              {entity.category}
            </span>
          )}
          {editingTitle ? (
            <input
              type="text"
              autoFocus
              value={entity.title}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => onEditTitle(entity.id, e.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') setEditingTitle(false);
              }}
              className="nodrag nopan nowheel min-w-0 flex-1 rounded border border-blue-400 bg-white px-1.5 py-0.5 text-xs font-bold text-slate-900 outline-none"
            />
          ) : (
            <span className="min-w-0 flex-1 select-none truncate px-0.5 text-xs font-bold text-slate-900">
              {entity.title}
            </span>
          )}
        </div>

        {/* 平时右上角只固定留一个 Lock 按钮；hover 时其余操作在 Lock 左侧浮现，0 位移不挤标题 */}
        <div className="nodrag nopan relative flex shrink-0 items-center">
          <div className="pointer-events-none absolute right-6 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 bg-gradient-to-r from-transparent via-white via-20% to-white pl-3 pr-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {(entity.hasLocalOverride || entity.hasRuntimeVars) && (
              <button
                type="button"
                title="还原为后端默认"
                onClick={(e) => {
                  e.stopPropagation();
                  onResetLocal(entity.id);
                }}
                className="flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-amber-800 hover:bg-amber-100"
              >
                <RotateCcw className="h-3 w-3" />
                还原
              </button>
            )}
            <button
              type="button"
              title="编辑属性 / 统一脚本 / 端口 / 按钮"
              onClick={(e) => {
                e.stopPropagation();
                onOpenInspector(entity.id);
              }}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-blue-700"
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
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={Boolean(entity.locked)}
              title={entity.locked ? '已锁定，解锁后可删除' : '删除控件'}
              onClick={(e) => {
                e.stopPropagation();
                if (!entity.locked) onDeleteNode(entity.id);
              }}
              className="rounded p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:pointer-events-none disabled:opacity-25"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <button
            type="button"
            title={entity.locked ? '已锁定位置（点此解锁拖动）' : '锁定控件位置（防止误拖）'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleLock(entity.id);
            }}
            className={`rounded p-1 ${
              entity.locked
                ? 'bg-slate-100 text-slate-800'
                : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            {entity.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* 主体区：默认整块正文可拖动，双击进入多行编辑；超长内容自动内部滚动不裁切 */}
      <div className="nowheel flex max-h-[420px] flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
        {hasScriptContents ? (
          <div className="flex flex-col gap-2">
            {flowItems.map((item, idx) =>
              Array.isArray(item) ? (
                <div key={`row-${idx}`} className="flex items-center gap-1.5">
                  {item.map((leaf, cidx) => renderLeafBlock(leaf, cidx, true))}
                </div>
              ) : (
                renderLeafBlock(item, idx, false)
              )
            )}
          </div>
        ) : (
          <>
            {editingBody ? (
              <textarea
                autoFocus
                value={entity.body}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => onEditBody(entity.id, e.target.value)}
                onBlur={() => setEditingBody(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingBody(false);
                }}
                rows={4}
                placeholder="输入正文内容（按 Esc 或点外部完成）…"
                className="nodrag nopan nowheel w-full flex-1 resize-y rounded border border-blue-400 bg-white p-1.5 text-xs leading-relaxed text-slate-700 outline-none"
              />
            ) : (
              <div
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingBody(true);
                }}
                title="按住拖动 · 双击编辑正文（支持 - [] / - [ ] / - [x] 复选框）"
                className="min-h-[44px] flex-1 select-none break-words rounded px-0.5 py-0.5 text-xs leading-relaxed text-slate-600 hover:bg-slate-50/70"
              >
                {entity.body ? (
                  <div className="flex flex-col gap-0.5">
                    {entity.body.split('\n').map((line, lineIdx) => {
                      const task = parseTaskLine(line);
                      if (task) {
                        return (
                          <div
                            key={`line-${lineIdx}`}
                            role="checkbox"
                            aria-checked={task.checked}
                            tabIndex={0}
                            onMouseDown={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditBody(entity.id, toggleTaskLine(entity.body, lineIdx));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === ' ' || e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                onEditBody(entity.id, toggleTaskLine(entity.body, lineIdx));
                              }
                            }}
                            className="nodrag nopan flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 transition-colors hover:bg-slate-100/90"
                            style={{ paddingLeft: task.indent.length * 6 + 4 }}
                          >
                            <span
                              aria-hidden="true"
                              className={`mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                task.checked
                                  ? 'border-blue-600 bg-blue-600 text-white'
                                  : 'border-slate-400 bg-white text-transparent hover:border-blue-500'
                              }`}
                            >
                              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="2.2 6.2 4.8 8.8 9.8 3.2" />
                              </svg>
                            </span>
                            <span
                              className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
                                task.checked ? 'text-slate-400 line-through' : 'text-slate-700'
                              }`}
                            >
                              {task.label || '\u00A0'}
                            </span>
                          </div>
                        );
                      }
                      return (
                        <div key={`line-${lineIdx}`} className="min-h-[1.25em] whitespace-pre-wrap break-words">
                          {line || '\u00A0'}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-slate-400">双击编辑正文…</span>
                )}
              </div>
            )}

            {varEntries.length > 0 && (
              <div className="flex select-none flex-wrap gap-1">
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
              <div className="flex flex-wrap gap-1.5">
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
          </>
        )}
      </div>
    </div>
  );
}

export const WidgetNode = memo(WidgetNodeInner);
