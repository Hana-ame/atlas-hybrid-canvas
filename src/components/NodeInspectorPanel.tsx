import { useState } from 'react';
import { BookmarkPlus, Copy, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import type { EffectiveBlueprintNode, WidgetButtonSpec } from '../core/types';

interface NodeInspectorPanelProps {
  node: EffectiveBlueprintNode | null;
  onClose: () => void;
  onPatchNode: (nodeId: string, patch: Partial<EffectiveBlueprintNode>) => void;
  onUpdateDefaultVar: (nodeId: string, key: string, value: string) => void;
  onDeleteDefaultVar: (nodeId: string, key: string) => void;
  onDuplicateNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onResetLocal: (nodeId: string) => void;
  onSaveAsTemplate: (node: EffectiveBlueprintNode) => void;
}

const COLOR_PALETTE = [
  '#1D4ED8',
  '#0F766E',
  '#059669',
  '#B45309',
  '#7C3AED',
  '#BE123C',
  '#0369A1',
  '#334155',
];

export function NodeInspectorPanel({
  node,
  onClose,
  onPatchNode,
  onUpdateDefaultVar,
  onDeleteDefaultVar,
  onDuplicateNode,
  onDeleteNode,
  onResetLocal,
  onSaveAsTemplate,
}: NodeInspectorPanelProps) {
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarVal, setNewVarVal] = useState('');

  if (!node) return null;

  const buttons = node.buttons ?? [];

  const handleAddButton = () => {
    const nextBtn: WidgetButtonSpec = {
      id: `btn-${Date.now()}`,
      label: '新交互按钮',
      variant: 'primary',
      actionType: 'script',
      code: `lib.inc('count', 1);
vars.updatedAt = lib.now();`,
    };
    onPatchNode(node.id, { buttons: [...buttons, nextBtn] });
  };

  const handleUpdateButton = (btnId: string, patch: Partial<WidgetButtonSpec>) => {
    onPatchNode(node.id, {
      buttons: buttons.map((b) => (b.id === btnId ? { ...b, ...patch } : b)),
    });
  };

  const handleRemoveButton = (btnId: string) => {
    onPatchNode(node.id, {
      buttons: buttons.filter((b) => b.id !== btnId),
    });
  };

  const handleAddVar = () => {
    const k = newVarKey.trim();
    if (!k) return;
    onUpdateDefaultVar(node.id, k, newVarVal);
    setNewVarKey('');
    setNewVarVal('');
  };

  return (
    <aside className="pointer-events-auto absolute top-16 right-3 bottom-12 z-30 flex w-96 flex-col rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-slate-900">编辑控件属性</div>
          <div className="font-mono text-[10px] text-slate-400">ID: {node.id}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        {/* 基础信息 */}
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block font-semibold text-slate-700">标题</label>
            <input
              type="text"
              value={node.title}
              onChange={(e) => onPatchNode(node.id, { title: e.target.value })}
              className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block font-semibold text-slate-700">分类标签</label>
              <input
                type="text"
                value={node.category ?? ''}
                onChange={(e) => onPatchNode(node.id, { category: e.target.value })}
                placeholder="如：知识 / 剧情 / API"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block font-semibold text-slate-700">主题色</label>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {COLOR_PALETTE.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => onPatchNode(node.id, { color: hex })}
                    className={`h-5 w-5 rounded-full border-2 ${
                      node.color === hex ? 'border-slate-900 scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block font-semibold text-slate-700">正文内容</label>
            <textarea
              rows={4}
              value={node.body}
              onChange={(e) => onPatchNode(node.id, { body: e.target.value })}
              className="w-full rounded-md border border-slate-200 p-2 text-xs leading-relaxed text-slate-800 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* 入/出箭头端口配置 */}
        <div className="border-t border-slate-100 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-800">
              入箭头端口 ({(node.inputPorts ?? [{ id: 'in-1', label: '入口 1' }, { id: 'in-2', label: '入口 2' }]).length})
            </span>
            <button
              type="button"
              onClick={() => {
                const cur = node.inputPorts ?? [
                  { id: 'in-1', label: '入口 1' },
                  { id: 'in-2', label: '入口 2' },
                ];
                onPatchNode(node.id, {
                  inputPorts: [...cur, { id: `in-${Date.now()}`, label: `入口 ${cur.length + 1}` }],
                });
              }}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <Plus className="h-3 w-3" />
              加一个入点
            </button>
          </div>
          <div className="space-y-1">
            {(node.inputPorts ?? [
              { id: 'in-1', label: '入口 1' },
              { id: 'in-2', label: '入口 2' },
            ]).map((port, idx, arr) => (
              <div key={port.id} className="flex items-center gap-1.5">
                <span className="w-10 shrink-0 font-mono text-[10px] text-slate-400">#{idx + 1}</span>
                <input
                  type="text"
                  value={port.label ?? ''}
                  onChange={(e) => {
                    onPatchNode(node.id, {
                      inputPorts: arr.map((p) => (p.id === port.id ? { ...p, label: e.target.value } : p)),
                    });
                  }}
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-blue-500"
                />
                {arr.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      onPatchNode(node.id, {
                        inputPorts: arr.filter((p) => p.id !== port.id),
                      })
                    }
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-800">
              出箭头端口 ({(node.outputPorts ?? [{ id: 'out-1', label: '出口 1' }]).length})
            </span>
            <button
              type="button"
              onClick={() => {
                const cur = node.outputPorts ?? [{ id: 'out-1', label: '出口 1' }];
                onPatchNode(node.id, {
                  outputPorts: [...cur, { id: `out-${Date.now()}`, label: `出口 ${cur.length + 1}` }],
                });
              }}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <Plus className="h-3 w-3" />
              加一个出点
            </button>
          </div>
          <div className="space-y-1">
            {(node.outputPorts ?? [{ id: 'out-1', label: '出口 1' }]).map((port, idx, arr) => (
              <div key={port.id} className="flex items-center gap-1.5">
                <span className="w-10 shrink-0 font-mono text-[10px] text-slate-400">#{idx + 1}</span>
                <input
                  type="text"
                  value={port.label ?? ''}
                  onChange={(e) => {
                    onPatchNode(node.id, {
                      outputPorts: arr.map((p) => (p.id === port.id ? { ...p, label: e.target.value } : p)),
                    });
                  }}
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-blue-500"
                />
                {arr.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      onPatchNode(node.id, {
                        outputPorts: arr.filter((p) => p.id !== port.id),
                      })
                    }
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 交互按钮与 Worker 脚本 */}
        <div className="border-t border-slate-100 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-800">交互按钮与脚本 ({buttons.length})</span>
            <button
              type="button"
              onClick={handleAddButton}
              className="inline-flex items-center gap-1 rounded bg-slate-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-slate-700"
            >
              <Plus className="h-3 w-3" />
              新增按钮
            </button>
          </div>

          <div className="space-y-2.5">
            {buttons.map((btn) => (
              <div key={btn.id} className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5">
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={btn.label}
                    onChange={(e) => handleUpdateButton(btn.id, { label: e.target.value })}
                    className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-900 outline-none focus:border-blue-500"
                  />
                  <select
                    value={btn.actionType}
                    onChange={(e) =>
                      handleUpdateButton(btn.id, {
                        actionType: e.target.value as 'script' | 'proxy_http',
                      })
                    }
                    className="rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700"
                  >
                    <option value="script">Worker 脚本</option>
                    <option value="proxy_http">代理 HTTP</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => handleRemoveButton(btn.id)}
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {btn.actionType === 'script' ? (
                  <textarea
                    rows={3}
                    value={btn.code ?? ''}
                    onChange={(e) => handleUpdateButton(btn.id, { code: e.target.value })}
                    placeholder="如: lib.inc('count', 1); vars.note = 'done';"
                    className="mt-2 w-full rounded border border-slate-200 bg-slate-900 p-2 font-mono text-[11px] text-emerald-300 outline-none focus:border-blue-500"
                  />
                ) : (
                  <div className="mt-2 flex gap-1.5">
                    <select
                      value={btn.proxyMethod ?? 'GET'}
                      onChange={(e) =>
                        handleUpdateButton(btn.id, {
                          proxyMethod: e.target.value as 'GET' | 'POST',
                        })
                      }
                      className="rounded border border-slate-200 bg-white px-1.5 py-1 font-mono text-[11px]"
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                    <input
                      type="text"
                      value={btn.proxyUrl ?? ''}
                      onChange={(e) => handleUpdateButton(btn.id, { proxyUrl: e.target.value })}
                      placeholder="https://httpbin.org/get"
                      className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px]"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 默认变量管理 */}
        <div className="border-t border-slate-100 pt-3">
          <div className="mb-2 font-semibold text-slate-800">默认变量 (defaultVars)</div>
          <div className="space-y-1">
            {Object.entries(node.defaultVars || {}).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 font-mono text-[11px]">
                <span className="truncate text-slate-700">
                  {k} = {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteDefaultVar(node.id, k)}
                  className="text-slate-400 hover:text-rose-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <input
              type="text"
              value={newVarKey}
              onChange={(e) => setNewVarKey(e.target.value)}
              placeholder="变量名"
              className="w-24 rounded border border-slate-200 px-2 py-1 font-mono text-[11px]"
            />
            <input
              type="text"
              value={newVarVal}
              onChange={(e) => setNewVarVal(e.target.value)}
              placeholder="默认值"
              className="flex-1 rounded border border-slate-200 px-2 py-1 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={handleAddVar}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              添加
            </button>
          </div>
        </div>
      </div>

      {/* 底部快捷操作 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-4 py-2.5">
        <button
          type="button"
          onClick={() => onSaveAsTemplate(node)}
          className="inline-flex items-center gap-1 rounded bg-blue-700 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-blue-800"
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          存为模板
        </button>
        <button
          type="button"
          onClick={() => onDuplicateNode(node.id)}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-[11px] text-slate-700 hover:bg-slate-50"
        >
          <Copy className="h-3.5 w-3.5" />
          复制
        </button>
        {(node.hasLocalOverride || node.hasRuntimeVars) && (
          <button
            type="button"
            onClick={() => onResetLocal(node.id)}
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 hover:bg-amber-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            还原默认
          </button>
        )}
        <button
          type="button"
          onClick={() => onDeleteNode(node.id)}
          className="ml-auto inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700 hover:bg-rose-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </button>
      </div>
    </aside>
  );
}
