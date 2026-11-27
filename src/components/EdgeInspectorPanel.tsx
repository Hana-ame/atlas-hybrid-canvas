/**
 * @file EdgeInspectorPanel.tsx
 * @description 连线样式与属性设置面板：支持修改标签、路径形状（平滑/直线/折线）、
 * 线型（实线/虚线/点线）、线宽、颜色、流动动画及单线双向切换。
 */

import { ArrowLeftRight, GitCommitHorizontal, Sliders, Trash2, X, Zap } from 'lucide-react';
import type { BlueprintEdge, EdgePathType, EdgeStrokeStyle } from '../core/types';

interface EdgeInspectorPanelProps {
  edge: BlueprintEdge;
  sourceTitle: string;
  targetTitle: string;
  onUpdateEdge: (edgeId: string, patch: Partial<BlueprintEdge>) => void;
  onDeleteEdge: (edgeId: string) => void;
  onClose: () => void;
}

const COLOR_PRESETS = [
  { label: '默认灰', value: '#64748B' },
  { label: '科技蓝', value: '#2563EB' },
  { label: '翡翠绿', value: '#059669' },
  { label: '琥珀橙', value: '#D97706' },
  { label: '玫瑰红', value: '#E11D48' },
  { label: '紫罗兰', value: '#7C3AED' },
  { label: '深墨黑', value: '#0F172A' },
];

const STROKE_STYLE_OPTIONS: Array<{ value: EdgeStrokeStyle; label: string; previewClass: string }> = [
  { value: 'solid', label: '实线', previewClass: 'border-solid' },
  { value: 'dashed', label: '虚线', previewClass: 'border-dashed' },
  { value: 'dotted', label: '点线', previewClass: 'border-dotted' },
];

const PATH_TYPE_OPTIONS: Array<{ value: EdgePathType; label: string }> = [
  { value: 'smooth', label: '平滑曲线' },
  { value: 'straight', label: '直线' },
  { value: 'step', label: '直角折线' },
];

const WIDTH_OPTIONS = [1.5, 2.2, 3, 4];

export function EdgeInspectorPanel({
  edge,
  sourceTitle,
  targetTitle,
  onUpdateEdge,
  onDeleteEdge,
  onClose,
}: EdgeInspectorPanelProps) {
  const currentStrokeStyle: EdgeStrokeStyle =
    edge.strokeStyle ?? (edge.dashed ? 'dashed' : 'solid');
  const currentPathType: EdgePathType = edge.pathType ?? 'smooth';
  const currentWidth = typeof edge.strokeWidth === 'number' ? edge.strokeWidth : 2.2;
  const currentColor = edge.color || '#64748B';
  const currentAnimated =
    edge.animated !== undefined ? edge.animated : (edge.strokeStyle ? false : Boolean(edge.dashed));

  return (
    <aside
      aria-label="连线样式设置"
      className="pointer-events-auto absolute top-16 right-3 bottom-12 z-30 flex w-80 flex-col rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur max-md:top-auto max-md:right-2 max-md:left-2 max-md:bottom-2 max-md:h-[62vh] max-md:w-auto max-md:rounded-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Sliders className="h-4 w-4 shrink-0 text-blue-700" />
            <span className="truncate text-sm font-bold text-slate-900">连线样式设置</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-slate-400">
            <span className="max-w-[100px] truncate">{sourceTitle}</span>
            <span>{edge.bidirectional ? '↔' : '→'}</span>
            <span className="max-w-[100px] truncate">{targetTitle}</span>
          </div>
        </div>
        <button
          type="button"
          title="关闭连线设置"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
        {/* 标签 */}
        <div>
          <label className="mb-1 block font-semibold text-slate-700">连线标签 (Label)</label>
          <input
            type="text"
            value={edge.label ?? ''}
            onChange={(e) => onUpdateEdge(edge.id, { label: e.target.value })}
            placeholder="输入连线标签（留空则隐藏）"
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-600"
          />
        </div>

        {/* 路径形状 */}
        <div>
          <label className="mb-1.5 block font-semibold text-slate-700">路径形状</label>
          <div className="grid grid-cols-3 gap-1.5">
            {PATH_TYPE_OPTIONS.map((opt) => {
              const active = currentPathType === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onUpdateEdge(edge.id, { pathType: opt.value })}
                  className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 线型 */}
        <div>
          <label className="mb-1.5 block font-semibold text-slate-700">线型</label>
          <div className="grid grid-cols-3 gap-1.5">
            {STROKE_STYLE_OPTIONS.map((opt) => {
              const active = currentStrokeStyle === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    onUpdateEdge(edge.id, {
                      strokeStyle: opt.value,
                      dashed: opt.value !== 'solid',
                      ...(edge.animated === undefined ? { animated: currentAnimated } : {}),
                    })
                  }
                  className={`flex flex-col items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span className={`w-full border-t-2 border-current ${opt.previewClass}`} />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 线宽 */}
        <div>
          <label className="mb-1.5 block font-semibold text-slate-700">线宽</label>
          <div className="grid grid-cols-4 gap-1.5">
            {WIDTH_OPTIONS.map((w) => {
              const active = Math.abs(currentWidth - w) < 0.1;
              return (
                <button
                  key={w}
                  type="button"
                  onClick={() => onUpdateEdge(edge.id, { strokeWidth: w })}
                  className={`flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 font-mono text-[11px] transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-50 font-bold text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <GitCommitHorizontal className="h-3 w-3" />
                  {w}px
                </button>
              );
            })}
          </div>
        </div>

        {/* 颜色 */}
        <div>
          <label className="mb-1.5 block font-semibold text-slate-700">连线颜色</label>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLOR_PRESETS.map((c) => {
              const active = currentColor.toLowerCase() === c.value.toLowerCase();
              return (
                <button
                  key={c.value}
                  type="button"
                  title={c.label}
                  onClick={() => onUpdateEdge(edge.id, { color: c.value })}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${
                    active ? 'scale-110 border-slate-900 ring-2 ring-blue-300' : 'border-white shadow-sm hover:scale-105'
                  }`}
                  style={{ backgroundColor: c.value }}
                />
              );
            })}
            <label
              title="自定义颜色"
              className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
            >
              <input
                type="color"
                value={currentColor.startsWith('#') ? currentColor : '#64748B'}
                onChange={(e) => onUpdateEdge(edge.id, { color: e.target.value })}
                className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
              />
              自定义
            </label>
          </div>
        </div>

        {/* 行为开关 */}
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <label className="flex cursor-pointer items-center justify-between rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50">
            <span className="flex items-center gap-1.5 font-medium text-slate-700">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              流动动画
            </span>
            <input
              type="checkbox"
              checked={currentAnimated}
              onChange={(e) => onUpdateEdge(edge.id, { animated: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50">
            <span className="flex items-center gap-1.5 font-medium text-slate-700">
              <ArrowLeftRight className="h-3.5 w-3.5 text-blue-600" />
              单线双向连线 (&lt;——&gt;)
            </span>
            <input
              type="checkbox"
              checked={Boolean(edge.bidirectional)}
              onChange={(e) => onUpdateEdge(edge.id, { bidirectional: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5">
        <button
          type="button"
          onClick={() => onDeleteEdge(edge.id)}
          className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除连线
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
        >
          完成
        </button>
      </div>
    </aside>
  );
}
