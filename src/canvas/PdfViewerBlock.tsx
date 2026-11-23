/**
 * @file PdfViewerBlock.tsx
 * @description 仿 Windows 图片查看器的 PDF 逐页图片查看控件：
 * - 严禁内置浏览器渲染：彻底无 iframe/embed/object，所有 PDF 均解包为逐页 PNG 图片；
 * - 严格 fit 控件大小：图片使用 w-full h-full object-contain，随控件放大/缩小等比自适应，不做双击放大；
 * - 零滚动条：全程 overflow-hidden，不提供滚动浏览，仅提供左右翻页箭头 + 底部极简页码栏；
 * - 一次性 URL/文件输入：成功解包并锁定来源后输入界面永久消失，不提供换源按钮。
 */

import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type TouchEvent } from 'react';
import { ChevronLeft, ChevronRight, FileImage, Loader2, Upload } from 'lucide-react';
import {
  buildPdfPageImageUrl,
  isSafePdfUrl,
  isUnpackedPdfTemplate,
  normalizePdfPage,
} from '../core/pdfHelper';
import {
  renderClientPdfPageImage,
  unpackPdfBytesInBrowser,
} from '../core/pdfClientUnpack';

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

  const serverImageSrc = buildPdfPageImageUrl(url, safePage);
  const isServerLocked = Boolean(serverImageSrc);

  const [urlDraft, setUrlDraft] = useState(isServerLocked ? '' : url);
  const [pageDraft, setPageDraft] = useState(String(safePage));
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [imgLoading, setImgLoading] = useState(false);

  const [clientDocId, setClientDocId] = useState<string | null>(null);
  const [clientPageImg, setClientPageImg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const autoUnpackedUrlRef = useRef<string>('');

  const isLocked = isServerLocked || Boolean(clientDocId);
  const currentImageSrc = isServerLocked ? serverImageSrc : clientPageImg;

  useEffect(() => {
    setPageDraft(String(safePage));
  }, [safePage]);

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

  useEffect(() => {
    if (!clientDocId || !mediaActive) return;
    let cancelled = false;
    setImgLoading(true);
    void (async () => {
      try {
        const dataUrl = await renderClientPdfPageImage(clientDocId, safePage);
        if (!cancelled) {
          setClientPageImg(dataUrl);
          setImgLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'PDF 页面渲染失败');
          setImgLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientDocId, safePage, mediaActive]);

  /** @returns 是否成功装载（成功锁定来源或切到 /page/{page} 模板）。供自动解包 effect 判断是否该清掉占位。 */
  const unpackFromUrl = useCallback(
    async (rawInput: string): Promise<boolean> => {
      const trimmed = rawInput.trim();
      if (!trimmed) {
        setErrorMsg('请输入 PDF 链接或选择本地 PDF 文件');
        return false;
      }
      if (!isSafePdfUrl(trimmed)) {
        setErrorMsg('仅支持 http/https 或合法 PDF 链接（拒绝 javascript:/data:）');
        return false;
      }
      if (isUnpackedPdfTemplate(trimmed)) {
        onChangeUrl(trimmed);
        onChangePage(1);
        return true;
      }

      setLoading(true);
      setErrorMsg('');
      try {
        const resp = await fetch('/api/pdf/unpack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          return true;
        }

        // 服务端返回了明确的业务错误（限流/未授权/私网拦截/解包失败）就直接展示，不再前端兜底。
        if (data?.error) {
          setErrorMsg(data.error);
          return false;
        }

        // 走到这里说明没有服务端（静态部署下 POST 打到 Pages 得到 404 + HTML，data 为 null）。
        // 退化为前端 pdf.js 解包：要求目标 PDF 自身允许 CORS 读取字节。
        const directResp = await fetch(trimmed);
        if (!directResp.ok) {
          setErrorMsg(`无法拉取 PDF（HTTP ${directResp.status}）`);
          return false;
        }
        const bytes = new Uint8Array(await directResp.arrayBuffer());
        const unpacked = await unpackPdfBytesInBrowser(bytes);
        setClientDocId(unpacked.clientDocId);
        onChangeTotalPages?.(unpacked.totalPages);
        onChangePage(1);
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setErrorMsg(
          `PDF 解包失败：当前为静态部署且目标地址未开放 CORS 读取（${detail}）。请改用「选择本地 PDF 文件」，或自建后端（npm run dev）后使用链接解包`
        );
        return false;
      } finally {
        setLoading(false);
      }
    },
    [onChangePage, onChangeTotalPages, onChangeUrl]
  );

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || isLocked || autoUnpackedUrlRef.current === trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) return;
    // 关键：先占位再调用。失败的场景下必须在 catch 里把它清掉，否则这个 URL 会被永久标记为
    // 「已尝试」，后续 effect 再也不会重跑——用户只能手动改 URL 再改回来才能重试。
    autoUnpackedUrlRef.current = trimmed;
    void unpackFromUrl(trimmed).then((ok) => {
      if (!ok && autoUnpackedUrlRef.current === trimmed) {
        autoUnpackedUrlRef.current = '';
      }
    });
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
          headers: {
            'Content-Type': 'application/pdf',
            'X-Pdf-Filename': encodeURIComponent(file.name),
          },
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
        // 服务端给出明确错误就直接展示；data 为 null 说明是静态部署（Pages 返回 404 + HTML），
        // 静默落到下方的前端 pdf.js 解包。
        if (data?.error) {
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

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      touchStartXRef.current = e.touches[0].clientX;
    }
  };

  const handleTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (touchStartXRef.current === null || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - touchStartXRef.current;
    touchStartXRef.current = null;
    if (dx > 45 && !atFirst) {
      commitPage(String(safePage - 1));
    } else if (dx < -45 && !atLast) {
      commitPage(String(safePage + 1));
    }
  };

  // 一次性输入态：成功解包锁定后永久消失
  if (!isLocked) {
    return (
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag nopan nowheel flex h-full min-h-[260px] w-full flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-slate-50 px-5 py-4 text-center"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileImage className="h-5 w-5" />}
        </div>
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-slate-800">
            {loading ? '正在解包 PDF 为逐页图片…' : '一次性加载 PDF（逐页图片查看器）'}
          </div>
          <div className="text-[11px] text-slate-500">
            加载成功后即锁定来源，按控件大小自适应展示单页图片
          </div>
        </div>

        <div className="flex w-full max-w-[340px] items-center gap-1.5">
          <input
            type="text"
            disabled={loading}
            value={urlDraft}
            placeholder="输入 https:// PDF 链接（一次性）…"
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void unpackFromUrl(urlDraft);
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => void unpackFromUrl(urlDraft)}
            className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            加载
          </button>
        </div>

        <div className="flex items-center gap-2">
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
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
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

  // 已锁定查看态：仿 Windows 图片查看器（严格 fit 控件大小 + 左右翻页 + 底部页码，零滚动条）
  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="nodrag nopan nowheel relative flex h-full min-h-[260px] w-full flex-1 flex-col overflow-hidden bg-neutral-900 outline-none select-none"
    >
      {/* 主图片视口：严格 w-full h-full object-contain 随控件大小缩放，无滚动条、无双击放大 */}
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden bg-neutral-900 p-2">
        {mediaActive ? (
          currentImageSrc ? (
            <img
              key={currentImageSrc}
              src={currentImageSrc}
              alt={`PDF 第 ${safePage} 页`}
              draggable={false}
              onLoad={() => setImgLoading(false)}
              onError={() => {
                setImgLoading(false);
                setErrorMsg(`第 ${safePage} 页图片加载失败`);
              }}
              className="h-full w-full object-contain"
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

        {imgLoading && mediaActive && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-neutral-900/40">
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          </div>
        )}

        {/* 左悬浮翻页箭头 */}
        <button
          type="button"
          disabled={atFirst}
          onClick={() => commitPage(String(safePage - 1))}
          title="上一页 (←)"
          aria-label="上一页"
          className="absolute left-2 top-1/2 z-10 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/75 disabled:pointer-events-none disabled:opacity-20"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        {/* 右悬浮翻页箭头 */}
        <button
          type="button"
          disabled={atLast}
          onClick={() => commitPage(String(safePage + 1))}
          title="下一页 (→)"
          aria-label="下一页"
          className="absolute right-2 top-1/2 z-10 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/75 disabled:pointer-events-none disabled:opacity-20"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {errorMsg && (
        <div className="border-t border-rose-900/50 bg-rose-950/90 px-2.5 py-1 text-center text-[11px] text-rose-200">
          {errorMsg}
        </div>
      )}

      {/* 底部极简页码栏：仅保留左右翻页与页码（无换源、无滚动控件） */}
      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-neutral-800 bg-neutral-950/95 px-3 py-1.5">
        <button
          type="button"
          disabled={atFirst}
          onClick={() => commitPage(String(safePage - 1))}
          title="上一页"
          aria-label="上一页"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-300 transition hover:bg-neutral-800 hover:text-white disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="inline-flex items-center gap-1 rounded-full bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-300">
          <input
            type="number"
            min={1}
            max={validTotal ?? 9999}
            value={pageDraft}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => commitPage(pageDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitPage(pageDraft);
              }
            }}
            aria-label="当前页码"
            className="w-8 bg-transparent text-center font-mono text-[11px] font-semibold text-white outline-none"
          />
          <span className="text-neutral-500">/</span>
          <span className="whitespace-nowrap font-medium text-neutral-300">
            共 {validTotal ?? '?'} 页
          </span>
        </div>

        <button
          type="button"
          disabled={atLast}
          onClick={() => commitPage(String(safePage + 1))}
          title="下一页"
          aria-label="下一页"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-300 transition hover:bg-neutral-800 hover:text-white disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export const PdfViewerBlock = memo(PdfViewerBlockInner);
