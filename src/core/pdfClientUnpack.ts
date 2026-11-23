/**
 * @file pdfClientUnpack.ts
 * @description 纯前端 PDF 高清逐页解包引擎（静态无后端模式兜底 + IndexedDB 分级缓存减压）：
 * - 绝不使用浏览器内置 PDF 渲染器；
 * - L1 内存仅保留最近 4 页热数据，L2 冷页卸载至 IndexedDB（全局上限 80 页 LRU 淘汰），大幅降低浏览器堆内存占用；
 * - 按当前控件物理像素宽度动态档位（1100/1700/2500/3600px）渲染离屏 Canvas 并导出 PNG，放大不发糊。
 */

import { idbCacheClearPrefix, idbCacheGet, idbCacheSet } from './idbStorage';

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
  /** L1 热内存缓存（严格上限 MAX_HOT_RAM_PAGES 页，超限自动踢出内存并保留在 IndexedDB L2） */
  pageCache: Map<string, string>;
}

const PDFJS_CDN_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';
const MAX_CANVAS_EDGE = 4096;
const MAX_CLIENT_DOCS = 3;
const MAX_HOT_RAM_PAGES = 4;
const MAX_IDB_PDF_PAGES = 80;

let pdfJsPromise: Promise<PdfJsModule> | null = null;
const clientDocStore = new Map<string, ClientUnpackedDoc>();

function makeIdbPageKey(clientDocId: string, cacheKey: string): string {
  return `pdf-page:${clientDocId}:${cacheKey}`;
}

function putHotPage(rec: ClientUnpackedDoc, cacheKey: string, dataUrl: string): void {
  rec.pageCache.delete(cacheKey);
  rec.pageCache.set(cacheKey, dataUrl);
  while (rec.pageCache.size > MAX_HOT_RAM_PAGES) {
    const oldest = rec.pageCache.keys().next().value;
    if (oldest === undefined) break;
    rec.pageCache.delete(oldest);
  }
}

export function disposeClientPdfDoc(clientDocId: string): void {
  const rec = clientDocStore.get(clientDocId);
  if (!rec) return;
  clientDocStore.delete(clientDocId);
  rec.pageCache.clear();
  void idbCacheClearPrefix(`pdf-page:${clientDocId}:`);
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

  // 1) L1 热内存命中
  const hotHit = rec.pageCache.get(cacheKey);
  if (hotHit) {
    putHotPage(rec, cacheKey, hotHit);
    return hotHit;
  }

  // 2) L2 IndexedDB 冷缓存命中（无需重新跑 pdf.js 渲染，也不常驻内存）
  const idbKey = makeIdbPageKey(clientDocId, cacheKey);
  const coldHit = await idbCacheGet<string>(idbKey);
  if (coldHit && clientDocStore.has(clientDocId)) {
    putHotPage(rec, cacheKey, coldHit);
    return coldHit;
  }

  // 3) 离屏 Canvas 渲染并同时回写 L1（4页热上限）+ L2 IndexedDB（80页冷上限）
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

  if (clientDocStore.has(clientDocId)) {
    putHotPage(rec, cacheKey, dataUrl);
    void idbCacheSet(idbKey, dataUrl, MAX_IDB_PDF_PAGES);
  }
  return dataUrl;
}
