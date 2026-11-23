/**
 * @file Pad2DControlBlock.tsx
 * @description 2D Pad 二维拖动条控件（风格与交互源自 pose-studio-3d 的 Color-picker 2D Pad）：
 * - 深色坐标面板 + 象限微光 + 中心基准线 + 实时十字准星 + 发光拖拽球（拖动时 1.18× 放大）；
 * - 支持 pointer capture 连续平滑拖动、双击回中归零，以及底部 X/Y 数值直输微调；
 * - 严格带 nodrag nopan nowheel，拖动 2D Pad 绝不误拖画布节点。
 */

import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  clampSliderValue,
  formatSliderValue,
  mapPadPointerToValues,
  mapPadValuesToPercent,
} from '../core/mediaHelper';

export interface Pad2DControlBlockProps {
  label?: string;
  labelX?: string;
  labelY?: string;
  x: number;
  y: number;
  minX?: number;
  maxX?: number;
  stepX?: number;
  minY?: number;
  maxY?: number;
  stepY?: number;
  unitX?: string;
  unitY?: string;
  invertY?: boolean;
  height?: number;
  accentColor?: string;
  onChange: (nextX: number, nextY: number) => void;
  onCommit?: (nextX: number, nextY: number) => void;
}

export function Pad2DControlBlock({
  label,
  labelX = 'X',
  labelY = 'Y',
  x,
  y,
  minX = -100,
  maxX = 100,
  stepX = 1,
  minY = -100,
  maxY = 100,
  stepY = 1,
  unitX = '',
  unitY = '',
  invertY = true,
  height = 176,
  accentColor = '#F59E0B',
  onChange,
  onCommit,
}: Pad2DControlBlockProps) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const latestRef = useRef<{ x: number; y: number }>({ x, y });
  const [isDragging, setIsDragging] = useState(false);

  const cfg = { minX, maxX, stepX, minY, maxY, stepY, invertY };
  const safeX = clampSliderValue(x, minX, maxX, stepX);
  const safeY = clampSliderValue(y, minY, maxY, stepY);
  latestRef.current = { x: safeX, y: safeY };

  const [xDraft, setXDraft] = useState(String(safeX));
  const [yDraft, setYDraft] = useState(String(safeY));

  useEffect(() => {
    setXDraft(String(safeX));
  }, [safeX]);

  useEffect(() => {
    setYDraft(String(safeY));
  }, [safeY]);

  const { leftPct, topPct } = mapPadValuesToPercent(safeX, safeY, cfg);

  const emitFromEvent = (clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = (clientX - rect.left) / Math.max(rect.width, 1);
    const ny = (clientY - rect.top) / Math.max(rect.height, 1);
    const next = mapPadPointerToValues(nx, ny, cfg);
    latestRef.current = next;
    onChange(next.x, next.y);
  };

  const resetToCenter = () => {
    const cx = clampSliderValue((minX + maxX) / 2, minX, maxX, stepX);
    const cy = clampSliderValue((minY + maxY) / 2, minY, maxY, stepY);
    latestRef.current = { x: cx, y: cy };
    onChange(cx, cy);
    onCommit?.(cx, cy);
  };

  const finishDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    onCommit?.(latestRef.current.x, latestRef.current.y);
  };

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="nodrag nopan nowheel flex w-full flex-col gap-1.5 select-none"
    >
      {/* 顶栏标题与重置按钮 */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate font-medium text-slate-700">{label || '2D Pad 触控板'}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-400">双击归中</span>
          <button
            type="button"
            title="复位到中心"
            onClick={(e) => {
              e.stopPropagation();
              resetToCenter();
            }}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 2D Pad 触控区（复刻 pose-studio-3d 风格） */}
      <div
        ref={padRef}
        role="slider"
        aria-label={label || '2D Pad'}
        aria-valuetext={`${labelX} ${formatSliderValue(safeX, unitX, stepX)}, ${labelY} ${formatSliderValue(safeY, unitY, stepY)}`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          draggingRef.current = true;
          setIsDragging(true);
          emitFromEvent(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          e.stopPropagation();
          emitFromEvent(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          finishDrag();
        }}
        onPointerCancel={(e) => {
          e.stopPropagation();
          finishDrag();
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resetToCenter();
        }}
        style={{
          height: Math.max(100, height),
          touchAction: 'none',
          background: `
            radial-gradient(circle at 50% 0%, rgba(239, 68, 68, 0.24), transparent 62%),
            radial-gradient(circle at 50% 100%, rgba(239, 68, 68, 0.14), transparent 62%),
            radial-gradient(circle at 100% 50%, rgba(34, 197, 94, 0.24), transparent 62%),
            radial-gradient(circle at 0% 50%, rgba(34, 197, 94, 0.14), transparent 62%),
            linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            #11141b
          `,
          backgroundSize: '100% 100%, 100% 100%, 100% 100%, 100% 100%, 25% 25%, 25% 25%, 100% 100%',
          boxShadow: 'inset 0 2px 10px rgba(0, 0, 0, 0.45)',
        }}
        className="relative w-full cursor-crosshair overflow-hidden rounded-xl border border-slate-700/80"
      >
        {/* 中心十字基准线 */}
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px bg-white/15" />
        <div className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px bg-white/15" />

        {/* 实时十字准星 */}
        <div
          className="pointer-events-none absolute left-0 right-0 h-px"
          style={{ top: `${topPct}%`, backgroundColor: `${accentColor}66` }}
        />
        <div
          className="pointer-events-none absolute bottom-0 top-0 w-px"
          style={{ left: `${leftPct}%`, backgroundColor: `${accentColor}66` }}
        />

        {/* 四边轴向角标 */}
        <span className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 font-mono text-[9px] text-rose-300/80">
          {labelY}+
        </span>
        <span className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 font-mono text-[9px] text-rose-300/60">
          {labelY}-
        </span>
        <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-emerald-300/60">
          {labelX}-
        </span>
        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-emerald-300/80">
          {labelX}+
        </span>

        {/* 发光拖拽球 (pad-puck) */}
        <div
          className="pointer-events-none absolute h-[18px] w-[18px] rounded-full border-[2.5px] border-white transition-transform duration-75"
          style={{
            left: `${leftPct}%`,
            top: `${topPct}%`,
            backgroundColor: accentColor,
            boxShadow: '0 0 0 1.5px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.6)',
            transform: isDragging ? 'translate(-50%, -50%) scale(1.18)' : 'translate(-50%, -50%)',
          }}
        />
      </div>

      {/* X / Y 实时数值读数与直输微调 */}
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex items-center justify-between gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px]">
          <span className="font-mono font-semibold text-emerald-700">{labelX}</span>
          <div className="flex items-center gap-0.5">
            <input
              type="text"
              inputMode="decimal"
              value={xDraft}
              onChange={(e) => {
                const raw = e.target.value;
                setXDraft(raw);
                if (raw.trim() !== '' && raw.trim() !== '-' && Number.isFinite(Number(raw))) {
                  const nextX = clampSliderValue(raw, minX, maxX, stepX);
                  onChange(nextX, safeY);
                }
              }}
              onBlur={() => {
                const nextX = clampSliderValue(xDraft, minX, maxX, stepX);
                setXDraft(String(nextX));
                onChange(nextX, safeY);
                onCommit?.(nextX, safeY);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const nextX = clampSliderValue(xDraft, minX, maxX, stepX);
                  setXDraft(String(nextX));
                  onChange(nextX, safeY);
                  onCommit?.(nextX, safeY);
                }
              }}
              className="w-14 rounded border border-slate-200 bg-white px-1 py-0.5 text-right font-mono text-[11px] text-slate-800 outline-none focus:border-amber-500"
            />
            {unitX && <span className="font-mono text-[10px] text-slate-400">{unitX}</span>}
          </div>
        </label>
        <label className="flex items-center justify-between gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px]">
          <span className="font-mono font-semibold text-rose-600">{labelY}</span>
          <div className="flex items-center gap-0.5">
            <input
              type="text"
              inputMode="decimal"
              value={yDraft}
              onChange={(e) => {
                const raw = e.target.value;
                setYDraft(raw);
                if (raw.trim() !== '' && raw.trim() !== '-' && Number.isFinite(Number(raw))) {
                  const nextY = clampSliderValue(raw, minY, maxY, stepY);
                  onChange(safeX, nextY);
                }
              }}
              onBlur={() => {
                const nextY = clampSliderValue(yDraft, minY, maxY, stepY);
                setYDraft(String(nextY));
                onChange(safeX, nextY);
                onCommit?.(safeX, nextY);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const nextY = clampSliderValue(yDraft, minY, maxY, stepY);
                  setYDraft(String(nextY));
                  onChange(safeX, nextY);
                  onCommit?.(safeX, nextY);
                }
              }}
              className="w-14 rounded border border-slate-200 bg-white px-1 py-0.5 text-right font-mono text-[11px] text-slate-800 outline-none focus:border-amber-500"
            />
            {unitY && <span className="font-mono text-[10px] text-slate-400">{unitY}</span>}
          </div>
        </label>
      </div>
    </div>
  );
}
