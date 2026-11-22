import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import type { CanvasAnnotation } from '../core/types';

export interface AnnotationNodeData extends Record<string, unknown> {
  annotation: CanvasAnnotation;
  onUpdateAnnotation: (id: string, patch: Partial<CanvasAnnotation>) => void;
  onDeleteAnnotation: (id: string) => void;
}

function AnnotationNodeInner({ data }: NodeProps) {
  const { annotation, onUpdateAnnotation, onDeleteAnnotation } = data as AnnotationNodeData;

  return (
    <div
      className="group rounded border-2 border-dashed border-amber-500/80 bg-amber-50/75 px-2.5 py-1.5 shadow-sm backdrop-blur-[1px]"
      style={{ width: annotation.width }}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium text-amber-900">
        <span>背景注释（拖动移动 · 关闭注释模式后恢复穿透）</span>
        <div className="nodrag flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              onUpdateAnnotation(annotation.id, {
                fontSize: Math.max(12, annotation.fontSize - 2),
              })
            }
            className="rounded border border-amber-300 bg-white px-1.5 py-0.5 hover:bg-amber-100"
          >
            A-
          </button>
          <button
            type="button"
            onClick={() =>
              onUpdateAnnotation(annotation.id, {
                fontSize: Math.min(48, annotation.fontSize + 2),
              })
            }
            className="rounded border border-amber-300 bg-white px-1.5 py-0.5 hover:bg-amber-100"
          >
            A+
          </button>
          <button
            type="button"
            title="删除注释"
            onClick={() => onDeleteAnnotation(annotation.id)}
            className="rounded border border-rose-200 bg-white p-0.5 text-rose-600 hover:bg-rose-50"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <input
        type="text"
        value={annotation.text}
        onChange={(e) => onUpdateAnnotation(annotation.id, { text: e.target.value })}
        className="nodrag w-full bg-transparent font-bold outline-none"
        style={{
          fontSize: annotation.fontSize,
          color: annotation.color,
        }}
      />
    </div>
  );
}

export const AnnotationNode = memo(AnnotationNodeInner);
