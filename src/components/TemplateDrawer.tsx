import { useMemo, useState, type DragEvent } from 'react';
import { BookmarkPlus, GripVertical, Play, Globe, Plus, Search, Trash2, X } from 'lucide-react';
import type { BlueprintTemplate, TemplateGroup } from '../core/types';

export const TEMPLATE_DRAG_MIME = 'application/x-atlas-template-id';

interface TemplateDrawerProps {
  open: boolean;
  templates: BlueprintTemplate[];
  onClose: () => void;
  onCreateCenter: (tpl: BlueprintTemplate) => void;
  onDeleteCustomTemplate: (id: string) => void;
}

const GROUPS: Array<TemplateGroup | '全部'> = [
  '全部',
  '知识地图',
  '策划与世界观',
  '工程与运维',
  '注释与基础',
  '我的模板',
];

export function TemplateDrawer({
  open,
  templates,
  onClose,
  onCreateCenter,
  onDeleteCustomTemplate,
}: TemplateDrawerProps) {
  const [group, setGroup] = useState<TemplateGroup | '全部'>('全部');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (group !== '全部' && t.group !== group) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.group.toLowerCase().includes(q)
      );
    });
  }, [templates, group, query]);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, tpl: BlueprintTemplate) => {
    e.dataTransfer.setData(TEMPLATE_DRAG_MIME, tpl.id);
    e.dataTransfer.setData('text/plain', tpl.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  if (!open) return null;

  return (
    <aside className="pointer-events-auto absolute top-16 left-3 bottom-12 z-30 flex w-80 flex-col rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-slate-100 px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <BookmarkPlus className="h-4 w-4 text-blue-700" />
          <span className="text-sm font-bold text-slate-900">控件模板（直接拖入画布）</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-slate-100 px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2.5 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模板（拖到画布任意位置即可创建）"
            className="w-full rounded-md border border-slate-200 bg-slate-50 py-1.5 pr-2.5 pl-8 text-xs text-slate-800 outline-none focus:border-blue-500 focus:bg-white"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                group === g
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {filtered.length === 0 && (
          <div className="py-8 text-center text-xs text-slate-400">没有匹配的模板</div>
        )}

        {filtered.map((tpl) => {
          const isAnn = tpl.kind === 'annotation';
          const np = tpl.nodePreset;
          const ap = tpl.annotationPreset;
          const varKeys = np ? Object.keys(np.defaultVars || {}) : [];

          return (
            <div
              key={tpl.id}
              draggable
              onDragStart={(e) => handleDragStart(e, tpl)}
              className={`group cursor-grab rounded-lg transition active:cursor-grabbing ${
                isAnn
                  ? 'border-2 border-dashed border-teal-500/60 bg-teal-50/40 p-2.5 hover:border-teal-600 hover:bg-teal-50/80'
                  : 'border border-slate-200 bg-white shadow-sm hover:shadow-md'
              }`}
              style={!isAnn ? { borderTopColor: tpl.color, borderTopWidth: 4 } : undefined}
            >
              {/* WYSIWYG 控件预览头部 */}
              <div className={`flex items-center justify-between gap-1.5 ${isAnn ? '' : 'border-b border-slate-100 px-2.5 py-1.5'}`}>
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />
                  {!isAnn && np?.category && (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white"
                      style={{ backgroundColor: tpl.color }}
                    >
                      {np.category}
                    </span>
                  )}
                  <span className="truncate text-xs font-bold text-slate-900">
                    {isAnn ? tpl.name : np?.title || tpl.name}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    title="直接添加到画布中央"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateCenter(tpl);
                    }}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-700"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {tpl.group === '我的模板' && (
                    <button
                      type="button"
                      title="删除自定义模板"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteCustomTemplate(tpl.id);
                      }}
                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* WYSIWYG 控件预览正文与按钮 */}
              {isAnn ? (
                <div
                  className="mt-1.5 truncate font-bold"
                  style={{
                    color: ap?.color || '#0F766E',
                    fontSize: Math.min(15, Math.max(12, (ap?.fontSize || 16) * 0.65)),
                  }}
                >
                  {ap?.text || tpl.description}
                </div>
              ) : (
                <div className="px-2.5 py-2">
                  <div className="line-clamp-2 whitespace-pre-line text-[11px] leading-relaxed text-slate-500">
                    {np?.body || tpl.description}
                  </div>

                  {varKeys.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {varKeys.slice(0, 3).map((k) => (
                        <span
                          key={k}
                          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                        >
                          {k}={String(np?.defaultVars[k])}
                        </span>
                      ))}
                    </div>
                  )}

                  {np?.buttons && np.buttons.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {np.buttons.map((b) => (
                        <span
                          key={b.id}
                          className="inline-flex items-center gap-1 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white"
                        >
                          {b.actionType === 'proxy_http' ? (
                            <Globe className="h-2.5 w-2.5" />
                          ) : (
                            <Play className="h-2.5 w-2.5" />
                          )}
                          {b.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
