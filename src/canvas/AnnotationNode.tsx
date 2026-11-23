/**
 * @file AnnotationNode.tsx
 * @description 背景注释编辑态组件（仅在开启「注释层：可拖动编辑」时挂载）。
 * 支持「文本框（text）」与「等比插图（image）」两类组件，提供顶部悬浮色板、底色块、本地换图与 NodeResizer，
 * 默认整框可拖、双击进入文字编辑，关闭编辑模式后自动卸载并烘焙回底层穿透 Canvas 瓦片。
 */

import { memo, useEffect, useState } from 'react';
import { isSafeImageUrl } from '../core/mediaHelper';
import type { NodeProps } from '@xyflow/react';
import { SmartNodeResizer } from './SmartNodeResizer';
import { ImagePlus, Trash2 } from 'lucide-react';
import { parseTaskLine, toggleTaskLine } from '../core/taskList';
import type { CanvasAnnotation } from '../core/types';

export interface AnnotationNodeData extends Record<string, unknown> {
  annotation: CanvasAnnotation;
  onUpdateAnnotation: (id: string, patch: Partial<CanvasAnnotation>) => void;
  onDeleteAnnotation: (id: string) => void;
}

const TEXT_COLORS = ['#0F172A', '#1E40AF', '#0F766E', '#047857', '#B45309', '#BE123C', '#6D28D9', '#FFFFFF'];
const BG_COLORS = ['transparent', '#FEF3C7', '#DBEAFE', '#CCFBF1', '#DCFCE7', '#FCE7F3', '#EDE9FE', '#E2E8F0', '#0F172A'];

function hexToRgba(hex: string | undefined, opacity: number): string {
  if (!hex || hex === 'transparent') return 'transparent';
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function AnnotationNodeInner({ data, selected }: NodeProps) {
  const { annotation, onUpdateAnnotation, onDeleteAnnotation } = data as AnnotationNodeData;
  const [editingText, setEditingText] = useState(false);
  const [editingImageUrl, setEditingImageUrl] = useState(false);
  const [imageUrlDraft, setImageUrlDraft] = useState(annotation.imageUrl || '');
  const [imageUrlError, setImageUrlError] = useState('');
  const [liveSize, setLiveSize] = useState<{ width: number; height: number } | null>(null);
  const displayWidth = liveSize ? liveSize.width : annotation.width;
  const displayHeight = liveSize ? liveSize.height : annotation.height;

  useEffect(() => {
    if (!selected) {
      setEditingText(false);
      setEditingImageUrl(false);
      setImageUrlError('');
    }
  }, [selected]);
  const isImage = annotation.kind === 'image';
  const bgOpacity = annotation.bgOpacity ?? 0.85;
  const bgCss = hexToRgba(annotation.bgColor, bgOpacity);

  const handleCommitImageUrl = () => {
    const trimmed = imageUrlDraft.trim();
    if (!trimmed) {
      onUpdateAnnotation(annotation.id, { imageUrl: '' });
      setImageUrlError('');
      setEditingImageUrl(false);
      return;
    }
    if (!isSafeImageUrl(trimmed)) {
      setImageUrlError('仅支持 http/https 外链或同源 /api/ 图片地址（拒绝 blob:/本地二进制）');
      return;
    }
    onUpdateAnnotation(annotation.id, { imageUrl: trimmed });
    setImageUrlError('');
    setEditingImageUrl(false);
  };
  return (
    <div
      className={`group relative rounded-lg transition-shadow ${
        selected ? 'ring-2 ring-amber-500' : 'ring-1 ring-dashed ring-amber-500/70'
      }`}
      style={{
        width: displayWidth,
        height: displayHeight,
        backgroundColor: bgCss,
      }}
    >
      <SmartNodeResizer
        isVisible={Boolean(selected)}
        minWidth={100}
        minHeight={isImage ? 80 : 40}
        lineClassName="!border-amber-500"
        handleClassName="!rounded-sm !border-2 !border-amber-600 !bg-white shadow-sm"
        onResize={(_ev, params) => {
          setLiveSize({ width: Math.round(params.width), height: Math.round(params.height) });
        }}
        onResizeEnd={(_ev, params) => {
          const w = Math.round(params.width);
          const h = Math.round(params.height);
          const nextX = Math.round(params.x);
          const nextY = Math.round(params.y);
          setLiveSize(null);
          onUpdateAnnotation(annotation.id, { x: nextX, y: nextY, width: w, height: h });
        }}
      />

      {liveSize && (
        <div className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-950/90 px-2.5 py-0.5 font-mono text-[11px] font-medium text-amber-100 shadow">
          {liveSize.width} × {liveSize.height}
        </div>
      )}

      {/* 顶部悬浮微型样式栏（仅编辑态可见，不占内容区高度，保持所见即所得） */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag nopan absolute -top-9 left-0 z-20 flex flex-nowrap items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[10px] shadow-md backdrop-blur"
      >
        <span className="font-mono text-slate-400" title="控件脚本可用此 ID 改变本背景">
          {annotation.id}
        </span>

        {!isImage && (
          <>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              onClick={() => onUpdateAnnotation(annotation.id, { fontSize: Math.max(12, annotation.fontSize - 2) })}
              className="rounded border border-slate-200 px-1 hover:bg-slate-100"
            >
              A-
            </button>
            <button
              type="button"
              onClick={() => onUpdateAnnotation(annotation.id, { fontSize: Math.min(48, annotation.fontSize + 2) })}
              className="rounded border border-slate-200 px-1 hover:bg-slate-100"
            >
              A+
            </button>
            <span className="text-slate-300">|</span>
            <span className="text-slate-500">字</span>
            {TEXT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onUpdateAnnotation(annotation.id, { color: c })}
                className={`h-3.5 w-3.5 rounded-full border ${
                  annotation.color === c ? 'border-slate-900 scale-110' : 'border-slate-300'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </>
        )}

        <span className="text-slate-300">|</span>
        <span className="text-slate-500">底</span>
        {BG_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c === 'transparent' ? '透明背景' : c}
            onClick={() => onUpdateAnnotation(annotation.id, { bgColor: c, bgOpacity: c === 'transparent' ? 0 : Math.max(0.6, bgOpacity) })}
            className={`h-3.5 w-3.5 rounded-sm border ${
              (annotation.bgColor || 'transparent') === c ? 'border-slate-900 scale-110' : 'border-slate-300'
            }`}
            style={{
              backgroundColor: c === 'transparent' ? '#FFFFFF' : c,
              backgroundImage:
                c === 'transparent'
                  ? 'linear-gradient(45deg, #cbd5e1 25%, transparent 25%, transparent 75%, #cbd5e1 75%)'
                  : undefined,
              backgroundSize: '6px 6px',
            }}
          />
        ))}

        {isImage && (
          <>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              onClick={() => {
                setImageUrlDraft(annotation.imageUrl || '');
                setImageUrlError('');
                setEditingImageUrl((v) => !v);
              }}
              className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-slate-700 hover:bg-slate-100"
            >
              <ImagePlus className="h-3 w-3" />
              外链换图
            </button>
          </>
        )}

        <button
          type="button"
          title="删除"
          onClick={() => onDeleteAnnotation(annotation.id)}
          className="ml-0.5 rounded p-0.5 text-rose-600 hover:bg-rose-50"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* 所见即所得内容区：文本框多行不拉伸 / 插图 object-contain 严格等比不拉伸 */}
      {isImage ? (
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg p-2">
          {editingImageUrl && (
            <div
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag nopan absolute inset-x-2 top-2 z-20 flex flex-col gap-1 rounded-md border border-slate-200 bg-white/95 p-2 shadow-md backdrop-blur"
            >
              <div className="flex items-center gap-1">
                <input
                  type="url"
                  autoFocus
                  value={imageUrlDraft}
                  onChange={(e) => setImageUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitImageUrl();
                    if (e.key === 'Escape') setEditingImageUrl(false);
                  }}
                  placeholder="输入 https:// 或 /api/ 图片外链…"
                  className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-800 outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={handleCommitImageUrl}
                  className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-blue-700"
                >
                  应用
                </button>
              </div>
              {imageUrlError && <div className="text-[10px] text-rose-600">{imageUrlError}</div>}
            </div>
          )}
          {annotation.imageUrl && isSafeImageUrl(annotation.imageUrl) ? (
            <img
              src={annotation.imageUrl}
              alt={annotation.text || '背景插图'}
              draggable={false}
              className="pointer-events-none h-full w-full select-none object-contain"
            />
          ) : (
            <span className="text-xs text-slate-400">点击上方「外链换图」填写图片 URL</span>
          )}
        </div>
      ) : editingText ? (
        <textarea
          autoFocus
          value={annotation.text}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onUpdateAnnotation(annotation.id, { text: e.target.value })}
          onBlur={() => setEditingText(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditingText(false);
          }}
          className="nodrag nopan nowheel h-full w-full resize-none rounded-lg bg-transparent p-2.5 leading-snug outline-none ring-2 ring-blue-500/60"
          style={{
            fontSize: annotation.fontSize,
            fontWeight: annotation.weight === 'bold' ? 700 : 400,
            color: annotation.color,
          }}
        />
      ) : (
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingText(true);
          }}
          title="按住任意处拖动 · 双击编辑文字（支持 - [] / - [ ] / - [x] 复选框）"
          className="h-full w-full cursor-grab select-none overflow-hidden break-words rounded-lg p-2.5 leading-snug active:cursor-grabbing"
          style={{
            fontSize: annotation.fontSize,
            fontWeight: annotation.weight === 'bold' ? 700 : 400,
            color: annotation.color,
          }}
        >
          {annotation.text ? (
            <div className="flex flex-col gap-0.5">
              {annotation.text.split('\n').map((line, lineIdx) => {
                const task = parseTaskLine(line);
                if (task) {
                  const boxPx = Math.max(14, Math.round(annotation.fontSize * 0.82));
                  return (
                    <div
                      key={`ann-line-${lineIdx}`}
                      role="checkbox"
                      aria-checked={task.checked}
                      tabIndex={0}
                      onMouseDown={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateAnnotation(annotation.id, {
                          text: toggleTaskLine(annotation.text, lineIdx),
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          onUpdateAnnotation(annotation.id, {
                            text: toggleTaskLine(annotation.text, lineIdx),
                          });
                        }
                      }}
                      className="nodrag nopan flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 transition-colors hover:bg-black/5"
                      style={{ paddingLeft: task.indent.length * 6 + 4 }}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-[0.18em] inline-flex shrink-0 items-center justify-center rounded border transition-colors ${
                          task.checked
                            ? 'border-blue-600 bg-blue-600 text-white'
                            : 'border-slate-500 bg-white/90 text-transparent'
                        }`}
                        style={{ width: boxPx, height: boxPx }}
                      >
                        <svg viewBox="0 0 12 12" className="h-[75%] w-[75%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="2.2 6.2 4.8 8.8 9.8 3.2" />
                        </svg>
                      </span>
                      <span
                        className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
                          task.checked ? 'line-through opacity-55' : ''
                        }`}
                      >
                        {task.label || '\u00A0'}
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={`ann-line-${lineIdx}`} className="min-h-[1.2em] whitespace-pre-wrap break-words">
                    {line || '\u00A0'}
                  </div>
                );
              })}
            </div>
          ) : (
            '双击输入文字…'
          )}
        </div>
      )}
    </div>
  );
}

export const AnnotationNode = memo(AnnotationNodeInner);
