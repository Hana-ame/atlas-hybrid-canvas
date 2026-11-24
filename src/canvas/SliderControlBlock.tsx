/**
 * @file SliderControlBlock.tsx
 * @description 声明式拖动条控件（可用于独立拖动条节点，也可嵌入任意脚本节点的 vars.contents）。
 * - 严格隔离画布拖拽事件（nodrag nopan nowheel），拖动滑块绝不误拖卡片；
 * - 拖动中实时更新数值，松手后提交并触发脚本 onChange 与下游节点联动。
 */

import { clampSliderValue, formatSliderValue } from '../core/mediaHelper';

export interface SliderControlBlockProps {
  label?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  showValue?: boolean;
  accentColor?: string;
  width?: number;
  inRow?: boolean;
  onChange: (nextValue: number) => void;
  onCommit?: (nextValue: number) => void;
}

export function SliderControlBlock({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit,
  showValue = true,
  accentColor = '#2563EB',
  width,
  inRow = false,
  onChange,
  onCommit,
}: SliderControlBlockProps) {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? max : 100;
  const lo = Math.min(safeMin, safeMax);
  const hi = Math.max(safeMin, safeMax);
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const clamped = clampSliderValue(value, lo, hi, safeStep);
  const pct = hi > lo ? ((clamped - lo) / (hi - lo)) * 100 : 0;

  return (
    <div
      style={width ? { width } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={`nodrag nopan nowheel flex flex-col gap-1 rounded-md border border-slate-200/90 bg-slate-50/80 px-2.5 py-2 ${
        inRow && !width ? 'min-w-0 flex-1' : 'w-full'
      }`}
    >
      {(label || showValue) && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="truncate font-medium text-slate-700">{label || '数值'}</span>
          {showValue && (
            <span
              className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold shadow-2xs ring-1 ring-slate-200"
              style={{ color: accentColor }}
            >
              {formatSliderValue(clamped, unit, safeStep)}
            </span>
          )}
        </div>
      )}

      <div className="relative flex items-center py-0.5">
        <input
          type="range"
          min={lo}
          max={hi}
          step={safeStep}
          value={clamped}
          aria-label={label || '拖动条'}
          onChange={(e) => {
            const next = clampSliderValue(e.target.value, lo, hi, safeStep);
            onChange(next);
          }}
          onPointerUp={(e) => {
            const next = clampSliderValue((e.target as HTMLInputElement).value, lo, hi, safeStep);
            onCommit?.(next);
          }}
          onPointerCancel={(e) => {
            const next = clampSliderValue((e.target as HTMLInputElement).value, lo, hi, safeStep);
            onCommit?.(next);
          }}
          onKeyUp={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
              return;
            }
            const next = clampSliderValue((e.target as HTMLInputElement).value, lo, hi, safeStep);
            onCommit?.(next);
          }}
          style={{
            accentColor,
            background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${pct}%, #CBD5E1 ${pct}%, #CBD5E1 100%)`,
          }}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none"
        />
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
        <span>{formatSliderValue(lo, unit, safeStep)}</span>
        <span>{formatSliderValue(hi, unit, safeStep)}</span>
      </div>
    </div>
  );
}
