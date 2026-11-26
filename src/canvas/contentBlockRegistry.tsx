/**
 * @file contentBlockRegistry.tsx
 * @description 声明式 vars.contents 控件注册表（将 WidgetNode 中的巨型条件渲染链解耦，并对重型媒体/轮询控件实施 React.lazy 代码分割）。
 * 后续新增声明式控件只需向 CONTENT_BLOCK_REGISTRY 注册对应渲染器，无需修改 WidgetNode 主体。
 */

import { Suspense, lazy, type ReactNode } from 'react';
import { Loader2, Play } from 'lucide-react';
import { ImageNodeBlock } from './ImageNodeBlock';
import { SliderControlBlock } from './SliderControlBlock';
import { Pad2DControlBlock } from './Pad2DControlBlock';
import { ImageButtonBlock } from './ImageButtonBlock';
import { forceBackendProxy } from '../core/runtimeConfig';
import type { ContentLeafBlock, EffectiveBlueprintNode } from '../core/types';

// 重型控件按需分包，显著压低首屏主 JS 包体积
const PdfViewerBlock = lazy(() =>
  import('./PdfViewerBlock').then((m) => ({ default: m.PdfViewerBlock }))
);
const VideoNodeBlock = lazy(() =>
  import('./VideoNodeBlock').then((m) => ({ default: m.VideoNodeBlock }))
);
const ApiPollerBlock = lazy(() =>
  import('./ApiPollerBlock').then((m) => ({ default: m.ApiPollerBlock }))
);

const VARIANT_CLASSES: Record<string, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'bg-slate-100 text-slate-800 hover:bg-slate-200 border border-slate-200',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800',
  danger: 'bg-rose-700 text-white hover:bg-rose-800',
};

export const IMMERSIVE_BLOCK_TYPES: ReadonlySet<string> = new Set(['pdf', 'image', 'video']);

function parseVarBoolean(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const s = String(raw ?? '').trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'null' && s !== 'undefined';
}

export interface ContentBlockRenderContext {
  entity: EffectiveBlueprintNode;
  idx: number;
  inRow: boolean;
  busyButtonKey: string | null;
  mediaActive: boolean;
  onRunScriptClick: (nodeId: string, buttonId: string) => void;
  onScriptInputChange: (nodeId: string, bindKey: string, value: string) => void;
  onSliderChange?: (nodeId: string, bindKey: string, value: number) => void;
  onSliderCommit?: (nodeId: string, bindKey: string, value: number) => void;
  onPad2DChange?: (nodeId: string, bindX: string, x: number, bindY: string, y: number) => void;
  onPad2DCommit?: (nodeId: string, bindX: string, x: number, bindY: string, y: number) => void;
  onImageButtonTrigger?: (
    nodeId: string,
    buttonId: string,
    bindKey: string,
    nextIsOn: boolean,
    toggle: boolean
  ) => void;
  onBatchUpdateVars?: (
    nodeId: string,
    patch: Record<string, unknown>,
    notifyDownstream?: boolean
  ) => void;
  onScriptInputSubmit: (nodeId: string, inputId: string, value: string) => void;
}

type BlockRenderer<T extends ContentLeafBlock = ContentLeafBlock> = (
  block: T,
  ctx: ContentBlockRenderContext
) => ReactNode;

const LazyFallback = (
  <div className="flex min-h-[64px] flex-1 items-center justify-center text-[11px] text-slate-400">
    加载控件中…
  </div>
);

const renderInputBlock: BlockRenderer<Extract<ContentLeafBlock, { type: 'input' | 'textarea' }>> = (
  block,
  { entity, idx, inRow, onScriptInputChange, onScriptInputSubmit }
) => {
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
};

export const CONTENT_BLOCK_REGISTRY: {
  [K in ContentLeafBlock['type']]: BlockRenderer<Extract<ContentLeafBlock, { type: K }>>;
} = {
  text: (block, { idx, inRow }) => (
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
  ),

  button: (block, { entity, idx, inRow, busyButtonKey, onRunScriptClick }) => {
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
        {isBusy ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Play className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{block.label}</span>
      </button>
    );
  },

  input: renderInputBlock,
  textarea: renderInputBlock,

  pdf: (block, { entity, idx, mediaActive, onScriptInputChange }) => {
    const urlKey = block.bindUrl || 'pdfUrl';
    const pageKey = block.bindPage || 'pdfPage';
    const proxyKey = block.bindProxy || 'pdfUseProxy';
    const curUrl =
      entity.effectiveVars?.[urlKey] !== undefined
        ? String(entity.effectiveVars[urlKey])
        : String(block.url ?? '');
    const curPage =
      entity.effectiveVars?.[pageKey] !== undefined
        ? Number(entity.effectiveVars[pageKey]) || 1
        : Number(block.page) || 1;
    const totalKey = 'pdfTotalPages';
    const curProxy =
      entity.effectiveVars?.[proxyKey] !== undefined
        ? parseVarBoolean(entity.effectiveVars[proxyKey])
        : Boolean(block.useProxy);
    const curTotal =
      entity.effectiveVars?.[totalKey] !== undefined
        ? Number(entity.effectiveVars[totalKey]) || 0
        : 0;
    return (
      <Suspense key={`pdf-${block.id}-${idx}`} fallback={LazyFallback}>
        <PdfViewerBlock
          url={curUrl}
          page={curPage}
          totalPages={curTotal > 0 ? curTotal : undefined}
          useProxy={curProxy}
          mediaActive={mediaActive}
          onChangeUrl={(nextUrl) => onScriptInputChange(entity.id, urlKey, nextUrl)}
          onChangePage={(nextPage) => onScriptInputChange(entity.id, pageKey, String(nextPage))}
          onChangeTotalPages={(nextTotal) =>
            onScriptInputChange(entity.id, totalKey, nextTotal > 0 ? String(nextTotal) : '')
          }
          onChangeUseProxy={(nextProxy) => onScriptInputChange(entity.id, proxyKey, nextProxy ? 'true' : '')}
        />
      </Suspense>
    );
  },

  api_poller: (block, { entity, idx, mediaActive, onScriptInputChange, onBatchUpdateVars }) => {
    const urlKey = block.bindUrl || 'pollUrl';
    const methodKey = block.bindMethod || 'pollMethod';
    const intervalKey = block.bindInterval || 'pollIntervalSec';
    const pathKey = block.bindJsonPath || 'pollJsonPath';
    const proxyKey = block.bindProxy || 'pollUseProxy';
    const enabledKey = block.bindEnabled || 'pollEnabled';

    const curUrl =
      entity.effectiveVars?.[urlKey] !== undefined
        ? String(entity.effectiveVars[urlKey])
        : String(block.url ?? '');
    const curMethod =
      String(entity.effectiveVars?.[methodKey] ?? block.method ?? 'GET').toUpperCase() === 'POST'
        ? 'POST'
        : 'GET';
    const curInterval =
      entity.effectiveVars?.[intervalKey] !== undefined
        ? Number(entity.effectiveVars[intervalKey]) || 10
        : Number(block.intervalSec) || 10;
    const curPath =
      entity.effectiveVars?.[pathKey] !== undefined
        ? String(entity.effectiveVars[pathKey])
        : String(block.jsonPath ?? '');
    const curProxy =
      entity.effectiveVars?.[proxyKey] !== undefined
        ? parseVarBoolean(entity.effectiveVars[proxyKey])
        : block.useProxy !== undefined
          ? Boolean(block.useProxy)
          : forceBackendProxy();
    const curEnabled =
      entity.effectiveVars?.[enabledKey] !== undefined
        ? parseVarBoolean(entity.effectiveVars[enabledKey])
        : Boolean(block.enabled);

    return (
      <Suspense key={`poller-${block.id}-${idx}`} fallback={LazyFallback}>
        <ApiPollerBlock
          url={curUrl}
          method={curMethod}
          intervalSec={curInterval}
          jsonPath={curPath}
          useProxy={curProxy}
          enabled={curEnabled}
          lastValue={entity.effectiveVars?.pollLastValue !== undefined ? String(entity.effectiveVars.pollLastValue) : ''}
          lastStatus={entity.effectiveVars?.pollStatus !== undefined ? String(entity.effectiveVars.pollStatus) : ''}
          lastUpdatedAt={
            entity.effectiveVars?.pollUpdatedAt !== undefined ? String(entity.effectiveVars.pollUpdatedAt) : ''
          }
          mediaActive={mediaActive}
          onChangeUrl={(nextUrl) => onScriptInputChange(entity.id, urlKey, nextUrl)}
          onChangeMethod={(nextMethod) => onScriptInputChange(entity.id, methodKey, nextMethod)}
          onChangeInterval={(nextSec) => onScriptInputChange(entity.id, intervalKey, String(nextSec))}
          onChangeJsonPath={(nextPath) => onScriptInputChange(entity.id, pathKey, nextPath)}
          onChangeUseProxy={(nextProxy) => onScriptInputChange(entity.id, proxyKey, nextProxy ? 'true' : '')}
          onChangeEnabled={(nextEnabled) => onScriptInputChange(entity.id, enabledKey, nextEnabled ? 'true' : '')}
          onPollResult={({ value, status, updatedAt, error }) => {
            if (onBatchUpdateVars) {
              onBatchUpdateVars(
                entity.id,
                {
                  pollLastValue: value,
                  pollStatus: status,
                  pollUpdatedAt: updatedAt,
                  pollError: error,
                },
                true
              );
            } else {
              onScriptInputChange(entity.id, 'pollLastValue', value);
              onScriptInputChange(entity.id, 'pollStatus', status);
              onScriptInputChange(entity.id, 'pollUpdatedAt', updatedAt);
              onScriptInputChange(entity.id, 'pollError', error);
            }
          }}
        />
      </Suspense>
    );
  },

  image: (block, { entity, idx, mediaActive, onScriptInputChange }) => {
    const urlKey = block.bindUrl || 'imageUrl';
    const captionKey = block.bindCaption || 'imageCaption';
    const fitKey = block.bindFit || 'imageFit';
    const curUrl =
      entity.effectiveVars?.[urlKey] !== undefined
        ? String(entity.effectiveVars[urlKey])
        : String(block.url ?? '');
    const curCaption =
      entity.effectiveVars?.[captionKey] !== undefined
        ? String(entity.effectiveVars[captionKey])
        : String(block.caption ?? '');
    const rawFit =
      entity.effectiveVars?.[fitKey] !== undefined
        ? String(entity.effectiveVars[fitKey])
        : String(block.fit ?? 'contain');
    const curFit: 'contain' | 'cover' = rawFit === 'cover' ? 'cover' : 'contain';
    return (
      <ImageNodeBlock
        key={`img-${block.id}-${idx}`}
        url={curUrl}
        caption={curCaption}
        fit={curFit}
        mediaActive={mediaActive}
        onChangeUrl={(nextUrl) => onScriptInputChange(entity.id, urlKey, nextUrl)}
        onChangeFit={(nextFit) => onScriptInputChange(entity.id, fitKey, nextFit)}
      />
    );
  },

  video: (block, { entity, idx, mediaActive, onScriptInputChange }) => {
    const urlKey = block.bindUrl || 'videoUrl';
    const loopKey = block.bindLoop || 'videoLoop';
    const mutedKey = block.bindMuted || 'videoMuted';
    const curUrl =
      entity.effectiveVars?.[urlKey] !== undefined
        ? String(entity.effectiveVars[urlKey])
        : String(block.url ?? '');
    const curLoop =
      entity.effectiveVars?.[loopKey] !== undefined
        ? parseVarBoolean(entity.effectiveVars[loopKey])
        : Boolean(block.loop);
    const curMuted =
      entity.effectiveVars?.[mutedKey] !== undefined
        ? parseVarBoolean(entity.effectiveVars[mutedKey])
        : Boolean(block.muted);
    return (
      <Suspense key={`vid-${block.id}-${idx}`} fallback={LazyFallback}>
        <VideoNodeBlock
          url={curUrl}
          poster={block.poster}
          loop={curLoop}
          muted={curMuted}
          mediaActive={mediaActive}
          onChangeUrl={(nextUrl) => onScriptInputChange(entity.id, urlKey, nextUrl)}
          onChangeLoop={(nextLoop) => onScriptInputChange(entity.id, loopKey, nextLoop ? 'true' : '')}
          onChangeMuted={(nextMuted) => onScriptInputChange(entity.id, mutedKey, nextMuted ? 'true' : '')}
        />
      </Suspense>
    );
  },

  slider: (block, { entity, idx, inRow, onSliderChange, onSliderCommit, onScriptInputChange }) => {
    const bindKey = block.bind || block.id;
    const rawVal = entity.effectiveVars?.[bindKey];
    const curVal =
      rawVal !== undefined && Number.isFinite(Number(rawVal))
        ? Number(rawVal)
        : Number.isFinite(Number(block.value))
          ? Number(block.value)
          : Number(block.min ?? 0);
    return (
      <SliderControlBlock
        key={`slider-${block.id}-${idx}`}
        label={block.label}
        value={curVal}
        min={block.min}
        max={block.max}
        step={block.step}
        unit={block.unit}
        showValue={block.showValue}
        accentColor={block.accentColor || entity.color}
        width={block.width}
        inRow={inRow}
        onChange={(nextVal) => {
          if (onSliderChange) onSliderChange(entity.id, bindKey, nextVal);
          else onScriptInputChange(entity.id, bindKey, String(nextVal));
        }}
        onCommit={(nextVal) => {
          onSliderCommit?.(entity.id, bindKey, nextVal);
        }}
      />
    );
  },

  pad2d: (block, { entity, idx, onPad2DChange, onPad2DCommit, onScriptInputChange }) => {
    const bindX = block.bindX || `${block.id}X`;
    const bindY = block.bindY || `${block.id}Y`;
    const rawX = entity.effectiveVars?.[bindX];
    const rawY = entity.effectiveVars?.[bindY];
    const curX =
      rawX !== undefined && Number.isFinite(Number(rawX))
        ? Number(rawX)
        : Number.isFinite(Number(block.x))
          ? Number(block.x)
          : 0;
    const curY =
      rawY !== undefined && Number.isFinite(Number(rawY))
        ? Number(rawY)
        : Number.isFinite(Number(block.y))
          ? Number(block.y)
          : 0;
    return (
      <Pad2DControlBlock
        key={`pad2d-${block.id}-${idx}`}
        label={block.label}
        labelX={block.labelX}
        labelY={block.labelY}
        x={curX}
        y={curY}
        minX={block.minX}
        maxX={block.maxX}
        stepX={block.stepX}
        minY={block.minY}
        maxY={block.maxY}
        stepY={block.stepY}
        unitX={block.unitX}
        unitY={block.unitY}
        invertY={block.invertY}
        height={block.height}
        accentColor={block.accentColor || '#F59E0B'}
        onChange={(nextX, nextY) => {
          if (onPad2DChange) onPad2DChange(entity.id, bindX, nextX, bindY, nextY);
          else {
            onScriptInputChange(entity.id, bindX, String(nextX));
            onScriptInputChange(entity.id, bindY, String(nextY));
          }
        }}
        onCommit={(nextX, nextY) => {
          onPad2DCommit?.(entity.id, bindX, nextX, bindY, nextY);
        }}
      />
    );
  },

  image_button: (block, { entity, idx, inRow, onImageButtonTrigger, onRunScriptClick, onScriptInputChange }) => {
    const bindKey = block.bind || block.id;
    const isToggle = block.toggle !== false;
    const curOn =
      entity.effectiveVars?.[bindKey] !== undefined
        ? parseVarBoolean(entity.effectiveVars[bindKey])
        : Boolean(block.on);
    const offKey = block.bindOffImage || `${block.id}OffImage`;
    const onKey = block.bindOnImage || `${block.id}OnImage`;
    const hoverKey = block.bindHoverImage || `${block.id}HoverImage`;
    const clickKey = block.bindClickImage || `${block.id}ClickImage`;
    const curOff =
      entity.effectiveVars?.[offKey] !== undefined
        ? String(entity.effectiveVars[offKey])
        : String(block.offImage ?? '');
    const curOnImg =
      entity.effectiveVars?.[onKey] !== undefined
        ? String(entity.effectiveVars[onKey])
        : String(block.onImage ?? '');
    const curHover =
      entity.effectiveVars?.[hoverKey] !== undefined
        ? String(entity.effectiveVars[hoverKey])
        : String(block.hoverImage ?? '');
    const curClick =
      entity.effectiveVars?.[clickKey] !== undefined
        ? String(entity.effectiveVars[clickKey])
        : String(block.clickImage ?? '');
    return (
      <ImageButtonBlock
        key={`imgbtn-${block.id}-${idx}`}
        label={block.label}
        isOn={curOn}
        toggle={isToggle}
        offImage={curOff}
        onImage={curOnImg}
        hoverImage={curHover}
        clickImage={curClick}
        width={block.width}
        height={block.height}
        disabled={Boolean(block.disabled)}
        showStateBadge={block.showStateBadge !== false}
        inRow={inRow}
        onTrigger={(nextIsOn) => {
          if (onImageButtonTrigger) {
            onImageButtonTrigger(entity.id, block.id, bindKey, nextIsOn, isToggle);
          } else {
            onRunScriptClick(entity.id, block.id);
          }
        }}
        onUpdateStateImage={(st, nextUrl) => {
          const targetKey =
            st === 'off' ? offKey : st === 'on' ? onKey : st === 'hover' ? hoverKey : clickKey;
          onScriptInputChange(entity.id, targetKey, nextUrl);
        }}
      />
    );
  },
};

/** 统一分发声明式控件渲染，未知类型静默跳过。 */
export function renderContentBlock(block: ContentLeafBlock, ctx: ContentBlockRenderContext): ReactNode {
  if (!block || typeof block !== 'object') return null;
  const renderer = CONTENT_BLOCK_REGISTRY[block.type] as BlockRenderer | undefined;
  return renderer ? renderer(block, ctx) : null;
}
