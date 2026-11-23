/**
 * @file ImageNodeBlock.tsx
 * @description 画布图片节点组件：支持图片 URL 加载、本地文件上传（<=4MB 转 data URL 持久化）、
 * 等比完整（contain）/ 铺满裁切（cover）切换、点击放大预览以及三环视口裁剪占位。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, Image as ImageIcon, Maximize2, Minimize2, RefreshCw, Upload, X } from 'lucide-react';
import { isSafeImageUrl } from '../core/mediaHelper';

const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ownedBlobRef = useRef<string | null>(null);

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

  useEffect(() => {
    return () => {
      if (ownedBlobRef.current) {
        URL.revokeObjectURL(ownedBlobRef.current);
        ownedBlobRef.current = null;
      }
    };
  }, []);

  const applyUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setErrorMsg('请输入图片链接或选择本地图片');
      return;
    }
    if (!isSafeImageUrl(trimmed)) {
      setErrorMsg('仅支持 http/https、本地上传或合法图片数据链接');
      return;
    }
    setErrorMsg('');
    setImgFailed(false);
    onChangeUrl(trimmed);
    setEditingSource(false);
  };

  const handleFileSelected = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErrorMsg('请选择有效的图片文件（PNG / JPG / WebP / GIF / SVG）');
      return;
    }
    setErrorMsg('');
    setImgFailed(false);

    // <= 4MB 转 data URL 以便刷新后仍保留在 IndexedDB 本地覆盖层
    if (file.size <= MAX_INLINE_IMAGE_BYTES) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string' && isSafeImageUrl(reader.result)) {
          if (ownedBlobRef.current) {
            URL.revokeObjectURL(ownedBlobRef.current);
            ownedBlobRef.current = null;
          }
          onChangeUrl(reader.result);
          setEditingSource(false);
        } else {
          setErrorMsg('图片读取失败，请换一张重试');
        }
      };
      reader.onerror = () => setErrorMsg('读取本地图片失败');
      reader.readAsDataURL(file);
      return;
    }

    // 超大图走临时 blob URL（避免膨胀 IndexedDB）
    if (ownedBlobRef.current) {
      URL.revokeObjectURL(ownedBlobRef.current);
    }
    const blobUrl = URL.createObjectURL(file);
    ownedBlobRef.current = blobUrl;
    onChangeUrl(blobUrl);
    setEditingSource(false);
  };

  const toggleFit = () => {
    onChangeFit?.(fit === 'contain' ? 'cover' : 'contain');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFileSelected(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />

      {editingSource || !safeUrl ? (
        <div
          className="nodrag nopan nowheel flex flex-1 flex-col items-center justify-center gap-2.5 p-3"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <ImageIcon className="h-5 w-5" />
          </div>
          <div className="text-center text-xs font-medium text-slate-700">加载图片到画布</div>
          <div className="flex w-full max-w-[320px] items-center gap-1.5">
            <input
              type="text"
              value={urlDraft}
              placeholder="粘贴图片 URL（https://...）"
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              <Upload className="h-3.5 w-3.5" />
              选择本地图片
            </button>
            {safeUrl && (
              <button
                type="button"
                onClick={() => setEditingSource(false)}
                className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-200/70"
              >
                取消
              </button>
            )}
          </div>
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
              <div className="text-xs text-rose-600">图片加载失败（可能跨域或链接已失效）</div>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setUrlDraft(safeUrl);
                  setEditingSource(true);
                }}
                className="inline-flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs text-white hover:bg-slate-700"
              >
                <RefreshCw className="h-3 w-3" />
                更换图片
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
              title="更换图片"
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
