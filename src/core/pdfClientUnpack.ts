/**
 * @file pdfClientUnpack.ts
 * @description 纯前端 PDF 解包为逐页图片引擎（静态无后端模式兜底）：
 * - 绝不使用浏览器内置 PDF 渲染器；
 * - 动态加载 pdf.js ESM 解析 PDF 二进制，按页渲染至离屏 Canvas 并导出 PNG DataURL 缓存。
 */

interface PdfJsViewport {
  width: number;
  height: number;
}

interface PdfJsPage {
  getViewport: (opts: { scale: number }) => PdfJsViewport;
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport }) => {
    promise: Promise<void>;
  };
}

interface PdfJsDoc {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
}

interface PdfJsModule {
  GlobalWorkerOptions?: { workerSrc: string };
  getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfJsDoc> };
}

interface ClientUnpackedDoc {
  id: string;
  totalPages: number;
  doc: PdfJsDoc;
  pageCache: Map<number, string>;
}

const PDFJS_CDN_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';

let pdfJsPromise: Promise<PdfJsModule> | null = null;
const clientDocStore = new Map<string, ClientUnpackedDoc>();

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<PdfJsModule>;
      const mod = await dynamicImport(PDFJS_CDN_URL);
      if (mod.GlobalWorkerOptions) {
        mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      }
      return mod;
    })().catch((err) => {
      pdfJsPromise = null;
      throw err;
    });
  }
  return pdfJsPromise;
}

export async function unpackPdfBytesInBrowser(
  bytes: Uint8Array
): Promise<{ clientDocId: string; totalPages: number }> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await loadingTask.promise;
  const clientDocId = `client-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  clientDocStore.set(clientDocId, {
    id: clientDocId,
    totalPages: doc.numPages,
    doc,
    pageCache: new Map(),
  });
  return { clientDocId, totalPages: doc.numPages };
}

export async function renderClientPdfPageImage(
  clientDocId: string,
  pageNumber: number
): Promise<string | null> {
  const rec = clientDocStore.get(clientDocId);
  if (!rec) return null;
  const safePage = Math.max(1, Math.min(rec.totalPages, Math.floor(pageNumber)));
  const cached = rec.pageCache.get(safePage);
  if (cached) return cached;

  const page = await rec.doc.getPage(safePage);
  const baseViewport = page.getViewport({ scale: 1 });
  const targetScale = Math.min(2, Math.max(1.2, 1200 / Math.max(1, baseViewport.width)));
  const viewport = page.getViewport({ scale: targetScale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/png');
  canvas.width = 0;
  canvas.height = 0;

  if (rec.pageCache.size >= 24) {
    const oldest = rec.pageCache.keys().next().value;
    if (oldest !== undefined) rec.pageCache.delete(oldest);
  }
  rec.pageCache.set(safePage, dataUrl);
  return dataUrl;
}
