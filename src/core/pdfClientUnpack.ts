/**
 * @file pdfClientUnpack.ts
 * @description 纯前端 PDF 高清逐页解包引擎（静态无后端模式兜底）：
 * - 绝不使用浏览器内置 PDF 渲染器；
 * - 按当前控件物理像素宽度动态档位（1100/1700/2500/3600px）渲染离屏 Canvas 并导出 PNG，放大不发糊。
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
  destroy?: () => Promise<void> | void;
}

interface PdfJsModule {
  GlobalWorkerOptions?: { workerSrc: string };
  getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfJsDoc> };
}

interface ClientUnpackedDoc {
  id: string;
  totalPages: number;
  doc: PdfJsDoc;
  pageCache: Map<string, string>;
}

const PDFJS_CDN_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';
const MAX_CANVAS_EDGE = 4096;
const MAX_CLIENT_DOCS = 6;

let pdfJsPromise: Promise<PdfJsModule> | null = null;
const clientDocStore = new Map<string, ClientUnpackedDoc>();

export function disposeClientPdfDoc(clientDocId: string): void {
  const rec = clientDocStore.get(clientDocId);
  if (!rec) return;
  clientDocStore.delete(clientDocId);
  rec.pageCache.clear();
  try {
    void rec.doc.destroy?.();
  } catch {
    // ignore
  }
}

export function hasClientPdfDoc(clientDocId: string): boolean {
  return clientDocStore.has(clientDocId);
}

function quantizeClientWidth(targetPixelWidth: number): number {
  if (!Number.isFinite(targetPixelWidth) || targetPixelWidth <= 1100) return 1100;
  if (targetPixelWidth <= 1700) return 1700;
  if (targetPixelWidth <= 2500) return 2500;
  return 3600;
}

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
  while (clientDocStore.size >= MAX_CLIENT_DOCS) {
    const oldestKey = clientDocStore.keys().next().value;
    if (!oldestKey) break;
    disposeClientPdfDoc(oldestKey);
  }
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
  pageNumber: number,
  targetPixelWidth = 1700
): Promise<string | null> {
  const rec = clientDocStore.get(clientDocId);
  if (!rec) return null;
  const rawPage = Number.isFinite(pageNumber) ? Math.floor(pageNumber) : 1;
  const safePage = Math.max(1, Math.min(Math.max(1, rec.totalPages), rawPage));
  const bucketW = quantizeClientWidth(targetPixelWidth);
  const cacheKey = `${safePage}@${bucketW}`;
  const cached = rec.pageCache.get(cacheKey);
  if (cached) return cached;

  const page = await rec.doc.getPage(safePage);
  const baseViewport = page.getViewport({ scale: 1 });
  const desiredScale = bucketW / Math.max(1, baseViewport.width);
  const maxSafeScale = MAX_CANVAS_EDGE / Math.max(1, Math.max(baseViewport.width, baseViewport.height));
  const targetScale = Math.max(0.1, Math.min(maxSafeScale, Math.max(1.2, Math.min(5, desiredScale))));
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

  if (rec.pageCache.size >= 32) {
    const oldest = rec.pageCache.keys().next().value;
    if (oldest !== undefined) rec.pageCache.delete(oldest);
  }
  rec.pageCache.set(cacheKey, dataUrl);
  return dataUrl;
}
