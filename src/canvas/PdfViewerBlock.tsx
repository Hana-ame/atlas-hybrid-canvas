/**
 * @file PdfViewerBlock.tsx
 * @description 仿 Windows 图片查看器的 PDF 逐页图片查看控件：
 * - 彻底无内置浏览器渲染，所有 PDF 均解包为逐页 PNG 图片；
 * - 严格 fit 控件大小（h-full w-full object-contain），动态匹配控件尺寸 × 画布缩放 × DPR 高清渲染；
 * - 零滚动条，仅保留左右翻页箭头与底部极简页码栏；
 * - URL/文件输入为一次性：成功解包锁定后输入界面永久消失；
 * - 除输入框与按钮外，卡片其余区域（图片区、空白背景）均可直接拖拽移动控件；
 * - 自动预加载下一页（及上一页）并在后台 decode 完成后无缝替换，翻页与高清升级零闪烁。
 */

import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useStore } from '@xyflow/react';
import { ChevronLeft, ChevronRight, FileImage, Loader2, Upload } from 'lucide-react';
import {
  buildPdfPageImageUrl,
  isSafePdfUrl,
  isUnpackedPdfTemplate,
  normalizePdfPage,
  pickPdfRenderDpi,
} from '../core/pdfHelper';
import {
  renderClientPdfPageImage,
  unpackPdfBytesInBrowser,
} from '../core/pdfClientUnpack';
import { proxyHeaders } from '../core/apiClient';

const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface PdfViewerBlockProps {
  url: string;
  page: number;
  totalPages?: number;
  useProxy: boolean;
  /** 是否处于当前视口或紧邻预加载环内；远端离屏时卸载图片节省显存 */
  mediaActive?: boolean;
  onChangeUrl: (nextUrl: string) => void;
  onChangePage: (nextPage: number) => void;
  onChangeTotalPages?: (nextTotal: number) => void;
  onChangeUseProxy: (nextProxy: boolean) => void;
}

function preloadDecodedImage(src: string, cacheSet: Set<string>): Promise<boolean> {
  if (cacheSet.has(src)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const done = () => {
        cacheSet.add(src);
        resolve(true);
      };
      if (typeof img.decode === 'function') {
        img.decode().then(done).catch(done);
      } else {
        done();
      }
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

function PdfViewerBlockInner({
  url,
  page,
  totalPages,
  mediaActive = true,
  onChangeUrl,
  onChangePage,
  onChangeTotalPages,
}: PdfViewerBlockProps) {
  const safePage = normalizePdfPage(page);
  const validTotal = totalPages && totalPages > 0 ? totalPages : null;

  const canvasZoom = useStore((s) => s.transform[2] || 1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(440);
  const [targetPixelWidth, setTargetPixelWidth] = useState(() =>
    Math.round(440 * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  );



  useEffect(() => {
    const dpr = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;
    const desired = Math.round(stageWidth * Math.max(0.5, canvasZoom) * dpr);
    const timer = window.setTimeout(() => {
      setTargetPixelWidth(desired);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [stageWidth, canvasZoom]);

  const activeDpi = pickPdfRenderDpi(targetPixelWidth);
  const serverImageSrc = buildPdfPageImageUrl(url, safePage, activeDpi);
  const isServerLocked = Boolean(serverImageSrc);

  const [urlDraft, setUrlDraft] = useState(isServerLocked ? '' : url);
  const [pageDraft, setPageDraft] = useState(String(safePage));
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [clientDocId, setClientDocId] = useState<string | null>(null);
  const [clientPageImg, setClientPageImg] = useState<string | null>(null);
  const [displayedServerSrc, setDisplayedServerSrc] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const preloadedSetRef = useRef<Set<string>>(new Set());
  const autoUnpackedUrlRef = useRef<string>('');

  const isLocked = isServerLocked || Boolean(clientDocId);

  // isLocked 切换时会卸载输入层并挂载查看层新 DOM，必须重新 observe 新的 stageRef
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const rectNow = el.getBoundingClientRect();
    if (rectNow.width > 0) {
      setStageWidth(Math.round(rectNow.width));
    }
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) {
        setStageWidth(Math.round(rect.width));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLocked]);

  useEffect(() => {
    setPageDraft(String(safePage));
  }, [safePage]);

  // 服务端图片无闪烁加载 + 自动预加载下一页与上一页
  useEffect(() => {
    if (!serverImageSrc || !mediaActive) return;
    let cancelled = false;
    setErrorMsg('');

    const triggerNeighborPreload = () => {
      const neighbors: number[] = [];
      if (!validTotal || safePage < validTotal) neighbors.push(safePage + 1);
      if (safePage > 1) neighbors.push(safePage - 1);
      for (const np of neighbors) {
        if (cancelled) break;
        const neighborSrc = buildPdfPageImageUrl(url, np, activeDpi);
        if (neighborSrc) {
          void preloadDecodedImage(neighborSrc, preloadedSetRef.current);
        }
      }
    };

    if (preloadedSetRef.current.has(serverImageSrc)) {
      setDisplayedServerSrc(serverImageSrc);
      triggerNeighborPreload();
      return;
    }

    void (async () => {
      const ok = await preloadDecodedImage(serverImageSrc, preloadedSetRef.current);
      if (cancelled) return;
      if (ok) {
        setDisplayedServerSrc(serverImageSrc);
      } else {
        setErrorMsg(`第 ${safePage} 页图片加载失败`);
      }
      triggerNeighborPreload();
    })();

    return () => {
      cancelled = true;
    };
  }, [serverImageSrc, mediaActive, safePage, validTotal, url, activeDpi]);

  useEffect(() => {
    if (!isServerLocked || validTotal) return;
    const m = url.trim().match(/^\/api\/pdf\/([a-zA-Z0-9_-]+)/);
    if (!m) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(`/api/pdf/${m[1]}/meta`);
        const data = (await resp.json().catch(() => null)) as { ok?: boolean; totalPages?: number } | null;
        if (!cancelled && resp.ok && data?.ok && data.totalPages && data.totalPages > 0) {
          onChangeTotalPages?.(data.totalPages);
        }
      } catch {
        // 忽略探测异常
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isServerLocked, url, validTotal, onChangeTotalPages]);

  // 前端解包模式：后台渲染当前页并原子替换（零闪烁），完成后静默预加载下一页与上一页
  useEffect(() => {
    if (!clientDocId || !mediaActive) return;
    let cancelled = false;
    void (async () => {
      try {
        const dataUrl = await renderClientPdfPageImage(clientDocId, safePage, targetPixelWidth);
        if (cancelled) return;
        if (dataUrl) {
          setClientPageImg(dataUrl);
          setErrorMsg('');
        }
        if (!validTotal || safePage < validTotal) {
          void renderClientPdfPageImage(clientDocId, safePage + 1, targetPixelWidth).catch(() => {});
        }
        if (safePage > 1) {
          void renderClientPdfPageImage(clientDocId, safePage - 1, targetPixelWidth).catch(() => {});
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'PDF 页面渲染失败');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientDocId, safePage, mediaActive, targetPixelWidth, validTotal]);

  const unpackFromUrl = useCallback(
    async (rawInput: string) => {
      const trimmed = rawInput.trim();
      if (!trimmed) {
        setErrorMsg('请输入 PDF 链接或选择本地 PDF 文件');
        return;
      }
      if (!isSafePdfUrl(trimmed)) {
        setErrorMsg('仅支持 http/https 或合法 PDF 链接（拒绝 javascript:/data:）');
        return;
      }
      if (isUnpackedPdfTemplate(trimmed)) {
        onChangeUrl(trimmed);
        onChangePage(1);
        return;
      }

      setLoading(true);
      setErrorMsg('');
      try {
        const resp = await fetch('/api/pdf/unpack', {
          method: 'POST',
          headers: proxyHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ url: trimmed }),
        });
        const data = (await resp.json().catch(() => null)) as {
          ok?: boolean;
          pageUrlTemplate?: string;
          totalPages?: number;
          error?: string;
        } | null;

        if (resp.ok && data?.ok && data.pageUrlTemplate) {
          onChangeTotalPages?.(data.totalPages ?? 1);
          onChangeUrl(data.pageUrlTemplate);
          onChangePage(1);
          return;
        }

        if (resp.status !== 404 && data?.error) {
          setErrorMsg(data.error);
          return;
        }

        const directResp = await fetch(trimmed);
        if (!directResp.ok) {
          setErrorMsg(`无法拉取 PDF（HTTP ${directResp.status}）`);
          return;
        }
        const bytes = new Uint8Array(await directResp.arrayBuffer());
        const unpacked = await unpackPdfBytesInBrowser(bytes);
        setClientDocId(unpacked.clientDocId);
        onChangeTotalPages?.(unpacked.totalPages);
        onChangePage(1);
      } catch {
        setErrorMsg('PDF 解包失败：远程地址可能未开放 CORS，请使用本地服务端（npm run dev）或直接选择本地 PDF 文件');
      } finally {
        setLoading(false);
      }
    },
    [onChangePage, onChangeTotalPages, onChangeUrl]
  );

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || isLocked || autoUnpackedUrlRef.current === trimmed) return;
    if (/^https?:\/\//i.test(trimmed)) {
      autoUnpackedUrlRef.current = trimmed;
      void unpackFromUrl(trimmed);
    }
  }, [url, isLocked, unpackFromUrl]);

  const handleFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('仅支持 .pdf 文件');
      return;
    }
    if (file.size > MAX_PDF_UPLOAD_BYTES) {
      setErrorMsg('PDF 文件超过 50MB 上限');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    try {
      try {
        const resp = await fetch('/api/pdf/unpack-upload', {
          method: 'POST',
          headers: proxyHeaders({
            'Content-Type': 'application/pdf',
            'X-Pdf-Filename': encodeURIComponent(file.name),
          }),
          body: file,
        });
        const data = (await resp.json().catch(() => null)) as {
          ok?: boolean;
          pageUrlTemplate?: string;
          totalPages?: number;
          error?: string;
        } | null;
        if (resp.ok && data?.ok && data.pageUrlTemplate) {
          onChangeTotalPages?.(data.totalPages ?? 1);
          onChangeUrl(data.pageUrlTemplate);
          onChangePage(1);
          return;
        }
        if (resp.status !== 404 && data?.error) {
          setErrorMsg(data.error);
          return;
        }
      } catch {
        // 静态模式无后端，回退至纯前端 pdf.js 解包
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const unpacked = await unpackPdfBytesInBrowser(bytes);
      setClientDocId(unpacked.clientDocId);
      onChangeTotalPages?.(unpacked.totalPages);
      onChangePage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'PDF 文件解包失败');
    } finally {
      setLoading(false);
    }
  };

  const commitPage = (raw: string) => {
    let next = normalizePdfPage(raw);
    if (validTotal) next = Math.min(validTotal, next);
    setPageDraft(String(next));
    onChangePage(next);
  };

  const atFirst = safePage <= 1;
  const atLast = Boolean(validTotal && safePage >= validTotal);
  const currentImageSrc = isServerLocked ? displayedServerSrc : clientPageImg;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isLocked) return;
    if (e.key === 'ArrowLeft' && !atFirst) {
      e.preventDefault();
      commitPage(String(safePage - 1));
    } else if (e.key === 'ArrowRight' && !atLast) {
      e.preventDefault();
      commitPage(String(safePage + 1));
    }
  };

  if (!isLocked) {
    return (
      <div
        ref={stageRef}
        className="flex h-full min-h-[260px] w-full flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-slate-50 px-5 py-4 text-center"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileImage className="h-5 w-5" />}
        </div>
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-slate-800">
            {loading ? '正在解包 PDF 为逐页高清图片…' : '一次性加载 PDF（逐页图片查看器）'}
          </div>
          <div className="text-[11px] text-slate-500">
            加载成功后即锁定来源，按控件大小自适应高清展示单页图片
          </div>
        </div>

        <div
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className="nodrag nopan nowheel flex w-full max-w-[340px] items-center gap-1.5"
        >
          <input
            ref={urlInputRef}
            type="url"
            inputMode="url"
            disabled={loading}
            value={urlDraft}
            placeholder="输入 https:// PDF 链接（一次性）…"
            style={{ touchAction: 'auto' }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget.focus();
            }}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void unpackFromUrl(urlDraft);
              }
            }}
            className="nodrag nopan nowheel min-w-0 flex-1 cursor-text select-text rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            type="button"
            disabled={loading}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void unpackFromUrl(urlDraft);
            }}
            className="nodrag nopan shrink-0 cursor-pointer rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            加载
          </button>
        </div>

        <div
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan flex items-center gap-2"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(ev) => void handleFilePick(ev)}
            className="hidden"
          />
          <button
            type="button"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            className="nodrag nopan inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            选择本地 PDF 文件解包
          </button>
        </div>

        {errorMsg && (
          <div className="w-full max-w-[340px] rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
            {errorMsg}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="relative flex h-full min-h-[260px] w-full flex-1 flex-col overflow-hidden bg-neutral-900 outline-none select-none"
    >
      <div
        ref={stageRef}
        className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden bg-neutral-900 p-2"
      >
        {mediaActive ? (
          currentImageSrc ? (
            <img
              src={currentImageSrc}
              alt={`PDF 第 ${safePage} 页`}
              draggable={false}
              className="pointer-events-none h-full w-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-1.5 text-xs text-neutral-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>正在渲染第 {safePage} 页…</span>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-xs text-neutral-400">
            <FileImage className="h-6 w-6 text-neutral-500" />
            <span>离屏休眠中（移近视口自动恢复第 {safePage} 页）</span>
          </div>
        )}

        <button
          type="button"
          disabled={atFirst}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            commitPage(String(safePage - 1));
          }}
          title="上一页 (←)"
          aria-label="上一页"
          className="nodrag nopan absolute left-2 top-1/2 z-10 inline-flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/75 disabled:pointer-events-none disabled:opacity-20"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <button
          type="button"
          disabled={atLast}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            commitPage(String(safePage + 1));
          }}
          title="下一页 (→)"
          aria-label="下一页"
          className="nodrag nopan absolute right-2 top-1/2 z-10 inline-flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/75 disabled:pointer-events-none disabled:opacity-20"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {errorMsg && (
        <div className="border-t border-rose-900/50 bg-rose-950/90 px-2.5 py-1 text-center text-[11px] text-rose-200">
          {errorMsg}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-neutral-800 bg-neutral-950/95 px-3 py-1.5">
        <button
          type="button"
          disabled={atFirst}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            commitPage(String(safePage - 1));
          }}
          title="上一页"
          aria-label="上一页"
          className="nodrag nopan inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-neutral-300 transition hover:bg-neutral-800 hover:text-white disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan inline-flex items-center gap-1 rounded-full bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-300"
        >
          <input
            type="number"
            min={1}
            max={validTotal ?? 9999}
            value={pageDraft}
            style={{ touchAction: 'auto' }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget.focus();
            }}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => commitPage(pageDraft)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitPage(pageDraft);
              }
            }}
            aria-label="当前页码"
            className="nodrag nopan nowheel w-8 cursor-text select-text bg-transparent text-center font-mono text-[11px] font-semibold text-white outline-none"
          />
          <span className="text-neutral-500">/</span>
          <span className="whitespace-nowrap font-medium text-neutral-300">
            共 {validTotal ?? '?'} 页
          </span>
        </div>

        <button
          type="button"
          disabled={atLast}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            commitPage(String(safePage + 1));
          }}
          title="下一页"
          aria-label="下一页"
          className="nodrag nopan inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-neutral-300 transition hover:bg-neutral-800 hover:text-white disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export const PdfViewerBlock = memo(PdfViewerBlockInner);
