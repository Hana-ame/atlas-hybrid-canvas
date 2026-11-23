/**
 * @file ImageNodeBlock.tsx
 * @description 画布图片节点组件（纯外链模式，禁止本地文件转 blob:/data: 占爆内存）：
 * 支持图片外链 URL（https/http 或同源 /api/）、等比完整（contain）/ 铺满裁切（cover）切换、
 * Portal 全屏灯箱预览（支持 Esc 关闭）以及三环视口裁剪占位。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, Image as ImageIcon, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { isSafeImageUrl } from '../core/mediaHelper';

export interface ImageNodeBlockProps {
  url: string;
  caption?: string;
  fit?: 'contain' | 'cover';
  mediaActive?: boolean;
  onChangeUrl: (nextUrl: string) => void;
  onChangeFit?: (nextFit: 'contain' | 'cover') => void;
  onChangeCaption?: (nextCaption: string) => void;
}

export function ImageNodeBlock({
  url,
  caption = '',
  fit = 'contain',
  mediaActive = true,
  onChangeUrl,
  onChangeFit,
}: ImageNodeBlockProps) {
  const safeUrl = isSafeImageUrl(url) ? url.trim() : '';
  const [urlDraft, setUrlDraft] = useState(safeUrl ? '' : url);
  const [errorMsg, setErrorMsg] = useState('');
  const [imgFailed, setImgFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [editingSource, setEditingSource] = useState(!safeUrl);

  useEffect(() => {
    setImgFailed(false);
    if (safeUrl) {
      setEditingSource(false);
      setErrorMsg('');
    } else {
      setEditingSource(true);
    }
  }, [safeUrl]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen]);

  const applyUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setErrorMsg('请输入图片外链 URL（https://...）');
      return;
    }
    if (!isSafeImageUrl(trimmed)) {
      setErrorMsg('仅支持 http/https 外链或同源 /api/ 图片地址（拒绝 blob:/本地二进制）');
      return;
    }
    setErrorMsg('');
    setImgFailed(false);
    onChangeUrl(trimmed);
    setEditingSource(false);
  };

  const toggleFit = () => {
    onChangeFit?.(fit === 'contain' ? 'cover' : 'contain');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50">
      {editingSource || !safeUrl ? (
        <div
          className="nodrag nopan nowheel flex flex-1 flex-col items-center justify-center gap-2.5 p-3"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <ImageIcon className="h-5 w-5" />
          </div>
          <div className="text-center text-xs font-medium text-slate-700">加载外链图片到画布</div>
          <div className="flex w-full max-w-[320px] items-center gap-1.5">
            <input
              type="text"
              value={urlDraft}
              placeholder="粘贴图片外链（https://...）"
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  applyUrl(urlDraft);
                }
              }}
              className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={() => applyUrl(urlDraft)}
              className="shrink-0 rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
            >
              加载
            </button>
          </div>
          {safeUrl && (
            <button
              type="button"
              onClick={() => setEditingSource(false)}
              className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-200/70"
            >
              取消
            </button>
          )}
          {errorMsg && <div className="text-center text-[11px] text-rose-600">{errorMsg}</div>}
        </div>
      ) : (
        <div className="group/img relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-slate-900/5">
          {!mediaActive ? (
            <div className="flex flex-col items-center gap-1 text-slate-400">
              <ImageIcon className="h-6 w-6" />
              <span className="text-[11px]">移入视口自动显示</span>
            </div>
          ) : imgFailed ? (
            <div className="nodrag nopan flex flex-col items-center gap-2 p-3 text-center">
              <div className="text-xs text-rose-600">图片加载失败（可能跨域或外链已失效）</div>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setUrlDraft(safeUrl.startsWith('data:') ? '' : safeUrl);
                  setEditingSource(true);
                }}
                className="inline-flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs text-white hover:bg-slate-700"
              >
                <RefreshCw className="h-3 w-3" />
                更换图片外链
              </button>
            </div>
          ) : (
            <img
              src={safeUrl}
              alt={caption || '画布图片'}
              draggable={false}
              onError={() => setImgFailed(true)}
              className={`h-full w-full select-none ${fit === 'cover' ? 'object-cover' : 'object-contain'}`}
            />
          )}

          {/* 悬浮工具栏 */}
          <div
            className="nodrag nopan absolute right-2 top-2 flex items-center gap-1 rounded-md bg-slate-900/75 p-1 text-white opacity-0 shadow backdrop-blur-sm transition-opacity group-hover/img:opacity-100"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title={fit === 'contain' ? '切换为铺满裁切 (cover)' : '切换为完整等比 (contain)'}
              onClick={toggleFit}
              className="rounded p-1 hover:bg-white/20"
            >
              {fit === 'contain' ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="大图预览"
              onClick={() => setLightboxOpen(true)}
              className="rounded p-1 hover:bg-white/20"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="更换图片外链"
              onClick={() => {
                setUrlDraft(safeUrl.startsWith('data:') ? '' : safeUrl);
                setEditingSource(true);
              }}
              className="rounded p-1 hover:bg-white/20"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {caption && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-slate-950/70 to-transparent px-2.5 pb-1.5 pt-4 text-[11px] text-white">
              {caption}
            </div>
          )}
        </div>
      )}

      {/* 大图灯箱预览（经 Portal 挂到 document.body，避免被 React Flow viewport transform 裁切） */}
      {lightboxOpen &&
        safeUrl &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 p-6 backdrop-blur-sm"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setLightboxOpen(false)}
          >
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
              className="absolute right-4 top-4 rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
              title="关闭预览 (Esc)"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={safeUrl}
              alt={caption || '大图预览'}
              onClick={(e) => e.stopPropagation()}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            />
          </div>,
          document.body
        )}
    </div>
  );
}
