import { memo, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { ImagePlus, Trash2 } from 'lucide-react';
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editingText, setEditingText] = useState(false);

  useEffect(() => {
    if (!selected) setEditingText(false);
  }, [selected]);
  const isImage = annotation.kind === 'image';
  const bgOpacity = annotation.bgOpacity ?? 0.85;
  const bgCss = hexToRgba(annotation.bgColor, bgOpacity);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onUpdateAnnotation(annotation.id, { imageUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div
      className={`group relative rounded-lg transition-shadow ${
        selected ? 'ring-2 ring-amber-500' : 'ring-1 ring-dashed ring-amber-500/70'
      }`}
      style={{
        width: annotation.width,
        height: annotation.height,
        backgroundColor: bgCss,
      }}
    >
      <NodeResizer
        isVisible={Boolean(selected)}
        keepAspectRatio={isImage}
        minWidth={100}
        minHeight={isImage ? 80 : 40}
        lineClassName="!border-amber-500"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-amber-600 !bg-white"
        onResizeEnd={(_ev, params) => {
          onUpdateAnnotation(annotation.id, {
            width: Math.round(params.width),
            height: Math.round(params.height),
          });
        }}
      />

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
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-slate-700 hover:bg-slate-100"
            >
              <ImagePlus className="h-3 w-3" />
              换图
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
        <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-lg p-2">
          {annotation.imageUrl ? (
            <img
              src={annotation.imageUrl}
              alt={annotation.text || '背景插图'}
              draggable={false}
              className="pointer-events-none h-full w-full select-none object-contain"
            />
          ) : (
            <span className="text-xs text-slate-400">点击上方「换图」选择插图</span>
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
          title="按住任意处拖动 · 双击编辑文字"
          className="h-full w-full cursor-grab select-none overflow-hidden whitespace-pre-wrap break-words rounded-lg p-2.5 leading-snug active:cursor-grabbing"
          style={{
            fontSize: annotation.fontSize,
            fontWeight: annotation.weight === 'bold' ? 700 : 400,
            color: annotation.color,
          }}
        >
          {annotation.text || '双击输入文字…'}
        </div>
      )}
    </div>
  );
}

export const AnnotationNode = memo(AnnotationNodeInner);
