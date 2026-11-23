/**
 * @file PdfViewerBlock.tsx
 * @description 沉浸式 PDF 阅读块组件：
 * - 无多余外框与内边距，PDF 视口随卡片尺寸自动铺满（支持 NodeResizer 自由拉伸）；
 * - 翻页栏置于最底部，居中展示「‹  [当前页] / 共 X 页  ›」，右侧提供折叠式「换源 / 上传 / Proxy」入口。
 */

import { memo, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ChevronLeft, ChevronRight, FileText, Globe, Link2, Upload } from 'lucide-react';
import {
  buildPdfIframeSrc,
  countPdfPagesFromBytes,
  createDemoSamplePdfBlobUrl,
  normalizePdfPage,
} from '../core/pdfHelper';

export interface PdfViewerBlockProps {
  url: string;
  page: number;
  totalPages?: number;
  useProxy: boolean;
  /** 是否处于当前视口或紧邻预加载环内；远端离屏时卸载重型 iframe 节省内存与 GPU */
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
  useProxy,
  mediaActive = true,
  onChangeUrl,
  onChangePage,
  onChangeTotalPages,
  onChangeUseProxy,
}: PdfViewerBlockProps) {
  const safePage = normalizePdfPage(page);
  const validTotal = totalPages && totalPages > 0 ? totalPages : null;
  const [urlDraft, setUrlDraft] = useState(url);
  const [pageDraft, setPageDraft] = useState(String(safePage));
  const [sourceOpen, setSourceOpen] = useState(!url);
  const [uploading, setUploading] = useState(false);
  const [tip, setTip] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ownedBlobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    setUrlDraft(url);
    if (url) setSourceOpen(false);
  }, [url]);

  useEffect(() => {
    setPageDraft(String(safePage));
  }, [safePage]);

  useEffect(() => {
    return () => {
      for (const b of ownedBlobUrlsRef.current) URL.revokeObjectURL(b);
    };
  }, []);

  // 自动尝试探测远程/代理/Blob PDF 总页数（跨域受限时静默跳过，不报错）
  useEffect(() => {
    if (!url || validTotal) return;
    const target = buildPdfIframeSrc(url, 1, useProxy)?.split('#')[0];
    if (!target) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(target);
        if (!resp.ok || cancelled) return;
        const buf = new Uint8Array(await resp.arrayBuffer());
        const detected = countPdfPagesFromBytes(buf);
        if (!cancelled && detected && detected > 0) {
          onChangeTotalPages?.(detected);
        }
      } catch {
        // 跨域拒绝读取字节时忽略，显示「共 ? 页」
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, useProxy, validTotal, onChangeTotalPages]);

  const commitPage = (raw: string) => {
    let next = normalizePdfPage(raw);
    if (validTotal) next = Math.min(validTotal, next);
    setPageDraft(String(next));
    onChangePage(next);
  };

  const commitUrl = () => {
    const trimmed = urlDraft.trim();
    setTip('');
    onChangeTotalPages?.(0);
    onChangeUrl(trimmed);
    onChangePage(1);
    if (trimmed) setSourceOpen(false);
  };

  const handleLoadDemoPdf = () => {
    const blobUrl = createDemoSamplePdfBlobUrl();
    ownedBlobUrlsRef.current.push(blobUrl);
    setTip('');
    onChangeUseProxy(false);
    onChangeTotalPages?.(3);
    onChangeUrl(blobUrl);
    onChangePage(1);
    setSourceOpen(false);
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setTip('仅支持 .pdf 文件');
      return;
    }

    setUploading(true);
    setTip('');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detectedPages = countPdfPagesFromBytes(bytes) ?? 0;

    try {
      // 直接以 application/pdf 提交原始字节，不再 base64 编码：
      // 少一层 4/3 膨胀与 FileReader 全量读入，上限即文件真实大小。
      if (useProxy && file.size <= 50 * 1024 * 1024) {
        const resp = await fetch('/api/pdf/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/pdf',
            'X-Pdf-Filename': encodeURIComponent(file.name),
          },
          body: file,
        });
        if (resp.ok) {
          const data = (await resp.json()) as { ok?: boolean; url?: string };
          if (data.ok && data.url) {
            onChangeTotalPages?.(detectedPages);
            onChangeUrl(data.url);
            onChangePage(1);
            setSourceOpen(false);
            setUploading(false);
            return;
          }
        } else {
          // 服务端明确拒绝（超限 / 非 PDF / 未授权）时说清原因，
          // 否则下面会静默降级成本地 Blob，用户不知道自己传的其实是本地文件。
          const data = (await resp.json().catch(() => null)) as { error?: string } | null;
          setTip(data?.error || `上传失败（HTTP ${resp.status}），已改用本地文件预览`);
        }
      }
    } catch {
      // 静态环境自动降级为本地 Blob URL
    }

    const localBlobUrl = URL.createObjectURL(file);
    ownedBlobUrlsRef.current.push(localBlobUrl);
    onChangeTotalPages?.(detectedPages);
    onChangeUrl(localBlobUrl);
    onChangePage(1);
    setSourceOpen(false);
    setUploading(false);
  };

  const iframeSrc = buildPdfIframeSrc(url, safePage, useProxy);
  const atFirst = safePage <= 1;
  const atLast = Boolean(validTotal && safePage >= validTotal);

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="nodrag nopan nowheel flex h-full min-h-[260px] w-full flex-1 flex-col overflow-hidden bg-slate-100/70"
    >
      {/* 折叠式换源栏：平时收起，点底部「换源」图标或未加载时展开 */}
      {sourceOpen && (
        <div className="flex items-center gap-1.5 border-b border-slate-200 bg-white px-2.5 py-1.5">
          <input
            type="text"
            value={urlDraft}
            placeholder="粘贴 PDF URL 或右侧上传…"
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitUrl();
              }
            }}
            className="min-w-0 flex-1 rounded border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] text-slate-900 outline-none focus:border-blue-500 focus:bg-white"
          />
          <button
            type="button"
            onClick={commitUrl}
            className="shrink-0 rounded bg-slate-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-slate-700"
          >
            打开
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(ev) => void handleFileUpload(ev)}
            className="hidden"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            title="上传本地 PDF（单文件上限 50MB）"
            className="inline-flex shrink-0 items-center gap-0.5 rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <Upload className="h-3 w-3" />
            上传
          </button>
          <label
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-slate-600 select-none"
            title="开启后通过服务端 /api/proxy/binary 或 /api/pdf/upload 代理"
          >
            <input
              type="checkbox"
              checked={useProxy}
              onChange={(e) => onChangeUseProxy(e.target.checked)}
              className="h-3 w-3 accent-blue-600"
            />
            <Globe className="h-3 w-3 text-slate-500" />
          </label>
        </div>
      )}

      {tip && (
        <div className="border-b border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] text-rose-700">
          {tip}
        </div>
      )}

      {/* 沉浸式 PDF 视口：仅在视口或紧邻预热区挂载重型 iframe，远端离屏自动休眠释放进程开销 */}
      {iframeSrc ? (
        mediaActive ? (
          <iframe
            key={iframeSrc}
            src={iframeSrc}
            title="PDF 预览"
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 bg-slate-50 px-4 text-center text-xs text-slate-400">
            <FileText className="h-6 w-6 text-slate-300" />
            <div>PDF 离屏休眠中（移近视口自动恢复第 {safePage} 页）</div>
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 bg-white px-4 text-center text-xs text-slate-500">
          <FileText className="h-7 w-7 text-slate-300" />
          <div className="text-slate-600">粘贴 PDF 链接、上传本地文件，或直接体验内置文档</div>
          <button
            type="button"
            onClick={handleLoadDemoPdf}
            className="rounded-full bg-slate-900 px-3.5 py-1.5 text-[11px] font-medium text-white transition hover:bg-slate-700"
          >
            加载内置 3 页演示 PDF
          </button>
        </div>
      )}

      {/* 底部极简沉浸式翻页栏：‹  [页码] / 共 X 页  ›  + 右侧换源按钮 */}
      <div className="flex items-center justify-between border-t border-slate-200/80 bg-white/95 px-2.5 py-1.5 backdrop-blur">
        <div className="w-12" />

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={atFirst}
            onClick={() => commitPage(String(safePage - 1))}
            title="上一页"
            aria-label="上一页"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <div className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
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
              className="w-8 bg-transparent text-center font-mono text-[11px] font-semibold text-slate-900 outline-none"
            />
            <span className="text-slate-400">/</span>
            <span className="whitespace-nowrap font-medium text-slate-600">
              共 {validTotal ?? '?'} 页
            </span>
          </div>

          <button
            type="button"
            disabled={atLast}
            onClick={() => commitPage(String(safePage + 1))}
            title="下一页"
            aria-label="下一页"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setSourceOpen((v) => !v)}
          title={sourceOpen ? '收起链接与上传栏' : '切换 PDF 链接 / 上传 / Proxy'}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition ${
            sourceOpen
              ? 'bg-slate-900 text-white'
              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
          }`}
        >
          <Link2 className="h-3 w-3" />
          换源
        </button>
      </div>
    </div>
  );
}

export const PdfViewerBlock = memo(PdfViewerBlockInner);
