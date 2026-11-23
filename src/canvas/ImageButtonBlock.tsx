/**
 * @file ImageButtonBlock.tsx
 * @description 四态图片按钮组件（纯外链贴图模式，支持 on / off / hover / click 四种独立状态）：
 * - 状态优先级：click（按下） > hover（悬停） > on（开启） > off（关闭）；
 * - 支持切换型（toggle=true，点击翻转 on/off 并触发脚本 on(id)）与点按型（toggle=false）；
 * - 右上角悬停提供四态外链 URL 快捷配置面板，不落大二进制到浏览器内存或 IndexedDB。
 */

import { useState } from 'react';
import { Image as ImageIcon, SlidersHorizontal, X } from 'lucide-react';
import {
  resolveImageButtonSrc,
  resolveImageButtonState,
  type ImageButtonState,
} from '../core/mediaHelper';

const STATE_META: Record<ImageButtonState, { label: string; badgeCls: string }> = {
  off: { label: 'OFF', badgeCls: 'bg-slate-800/80 text-slate-200' },
  on: { label: 'ON', badgeCls: 'bg-emerald-600/90 text-white' },
  hover: { label: 'HOVER', badgeCls: 'bg-indigo-600/90 text-white' },
  click: { label: 'CLICK', badgeCls: 'bg-amber-600/95 text-white' },
};

export interface ImageButtonBlockProps {
  label?: string;
  isOn: boolean;
  toggle?: boolean;
  offImage?: string;
  onImage?: string;
  hoverImage?: string;
  clickImage?: string;
  width?: number;
  height?: number;
  disabled?: boolean;
  showStateBadge?: boolean;
  inRow?: boolean;
  onTrigger: (nextIsOn: boolean) => void;
  onUpdateStateImage?: (state: ImageButtonState, nextUrl: string) => void;
}

export function ImageButtonBlock({
  label,
  isOn,
  toggle = true,
  offImage = '',
  onImage = '',
  hoverImage = '',
  clickImage = '',
  width,
  height = 88,
  disabled = false,
  showStateBadge = true,
  inRow = false,
  onTrigger,
  onUpdateStateImage,
}: ImageButtonBlockProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const activeState = resolveImageButtonState({ isOn, hovered, pressed });
  const activeSrc = resolveImageButtonSrc(
    { offImage, onImage, hoverImage, clickImage },
    activeState,
    isOn
  );

  const stateSources: Array<{ key: ImageButtonState; title: string; value: string }> = [
    { key: 'off', title: 'OFF（关闭态）', value: offImage },
    { key: 'on', title: 'ON（开启态）', value: onImage },
    { key: 'hover', title: 'HOVER（悬停态）', value: hoverImage },
    { key: 'click', title: 'CLICK（按下态）', value: clickImage },
  ];

  return (
    <div
      style={width ? { width } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={`nodrag nopan nowheel relative flex flex-col gap-1.5 ${
        inRow && !width ? 'min-w-0 flex-1' : 'w-full'
      }`}
    >
      <div className="group/ibtn relative">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={toggle ? isOn : undefined}
          aria-label={label || '图片按钮'}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => {
            setHovered(false);
            setPressed(false);
          }}
          onPointerDown={(e) => {
            if (disabled) return;
            e.stopPropagation();
            setPressed(true);
          }}
          onPointerUp={(e) => {
            e.stopPropagation();
            setPressed(false);
          }}
          onPointerCancel={() => setPressed(false)}
          onClick={(e) => {
            if (disabled) return;
            e.stopPropagation();
            const nextOn = toggle ? !isOn : isOn;
            onTrigger(nextOn);
          }}
          style={{ height: Math.max(44, height) }}
          className={`relative flex w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg border transition-transform duration-75 disabled:cursor-not-allowed disabled:opacity-50 ${
            pressed ? 'scale-[0.97]' : hovered ? 'scale-[1.01]' : ''
          } ${
            activeState === 'on'
              ? 'border-emerald-400/70 bg-emerald-50/40'
              : activeState === 'click'
                ? 'border-amber-400/80 bg-amber-50/40'
                : activeState === 'hover'
                  ? 'border-indigo-400/80 bg-indigo-50/40'
                  : 'border-slate-200 bg-slate-100/70'
          }`}
        >
          {activeSrc ? (
            <img
              src={activeSrc}
              alt={label || activeState}
              draggable={false}
              className="h-full w-full select-none object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-1 text-slate-400">
              <ImageIcon className="h-5 w-5" />
              <span className="text-[11px]">{label || `图片按钮 (${STATE_META[activeState].label})`}</span>
            </div>
          )}

          {showStateBadge && (
            <span
              className={`pointer-events-none absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider shadow-xs ${STATE_META[activeState].badgeCls}`}
            >
              {STATE_META[activeState].label}
            </span>
          )}

          {label && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 max-w-[65%] truncate rounded bg-slate-900/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {label}
            </span>
          )}
        </button>

        {onUpdateStateImage && (
          <button
            type="button"
            title="配置 on / off / hover / click 四态图片外链"
            onClick={(e) => {
              e.stopPropagation();
              setConfigOpen((v) => !v);
            }}
            className="absolute right-1.5 top-1.5 rounded bg-slate-900/70 p-1 text-white opacity-0 shadow transition-opacity hover:bg-slate-900 group-hover/ibtn:opacity-100"
          >
            {configOpen ? <X className="h-3 w-3" /> : <SlidersHorizontal className="h-3 w-3" />}
          </button>
        )}
      </div>

      {/* 四态贴图外链配置面板 */}
      {configOpen && onUpdateStateImage && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
          <div className="flex items-center justify-between text-[10px] font-semibold text-slate-600">
            <span>四态图片外链配置（https://...）</span>
            <button
              type="button"
              onClick={() => setConfigOpen(false)}
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {stateSources.map((st) => (
            <div key={st.key} className="flex items-center gap-1">
              <span className="w-12 shrink-0 font-mono text-[10px] font-semibold uppercase text-slate-600">
                {st.key}
              </span>
              <input
                type="text"
                value={st.value.startsWith('data:') ? '' : st.value}
                placeholder={st.value.startsWith('data:') ? '默认内置图标（可粘贴外链覆盖）' : `输入 ${st.key} 图片外链…`}
                onChange={(e) => onUpdateStateImage(st.key, e.target.value)}
                className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-800 outline-none focus:border-indigo-500"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
