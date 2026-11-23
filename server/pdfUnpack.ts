/**
 * @file pdfUnpack.ts
 * @description 服务端 PDF 多分辨率按需解包引擎：
 * - 校验 %PDF- 魔数并通过 pdfinfo/mutool 快速获取精确总页数；
 * - 按请求 DPI 档位（150 / 220 / 300 / 400）按需光栅化单页为超清 PNG，放大控件或缩放画布不发糊；
 * - 全程使用 execFile 传参数组，杜绝命令注入；
 * - 内置双维度 LRU 缓存（最多 15 份文档、单文档最多 80 张页图、全局总字节上限 256MB），防 OOM。
 *
 * 运行前提：宿主机必须提供 `pdftoppm`（poppler-utils）或 `mutool`（mupdf-tools）。
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_UNPACKED_DOCS = 15;
const MAX_CACHED_PAGE_IMAGES = 80;
const MAX_UNPACKED_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_RENDER_PAGES = 500;
const UNPACK_TIMEOUT_MS = 30_000;

export const ALLOWED_PDF_DPIS = [150, 220, 300, 400] as const;
export type AllowedPdfDpi = (typeof ALLOWED_PDF_DPIS)[number];

interface UnpackedPdfRecord {
  docId: string;
  pdfBytes: Buffer;
  totalPages: number;
  pageCache: Map<string, Buffer>;
  totalBytes: number;
  createdAt: number;
}

const unpackedStore = new Map<string, UnpackedPdfRecord>();
let globalCachedBytes = 0;

function evictGlobalIfNeeded(keepDocId?: string): void {
  while (
    unpackedStore.size > MAX_UNPACKED_DOCS ||
    (globalCachedBytes > MAX_UNPACKED_TOTAL_BYTES && unpackedStore.size > 1)
  ) {
    let victimKey: string | undefined;
    for (const k of unpackedStore.keys()) {
      if (k !== keepDocId) {
        victimKey = k;
        break;
      }
    }
    if (!victimKey) break;
    const victim = unpackedStore.get(victimKey);
    unpackedStore.delete(victimKey);
    if (victim) {
      globalCachedBytes = Math.max(0, globalCachedBytes - victim.totalBytes);
    }
  }
}

function touchDocLru(docId: string, record: UnpackedPdfRecord): void {
  unpackedStore.delete(docId);
  unpackedStore.set(docId, record);
  evictGlobalIfNeeded(docId);
}

export function normalizePdfDpi(raw?: unknown): AllowedPdfDpi {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 220;
  if (n <= 170) return 150;
  if (n <= 250) return 220;
  if (n <= 340) return 300;
  return 400;
}

export function isPdfMagicHeader(buf: Buffer): boolean {
  if (!buf || buf.byteLength < 5) return false;
  const head = buf.subarray(0, Math.min(1024, buf.byteLength)).toString('latin1');
  return head.includes('%PDF-');
}

async function detectPdfTotalPages(inputPath: string, pdfBytes: Buffer): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [inputPath], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const m = stdout.match(/^Pages:\s*(\d+)/m);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.min(MAX_RENDER_PAGES, n);
    }
  } catch {
    // fallback below
  }

  try {
    const { stdout } = await execFileAsync('mutool', ['info', inputPath], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const m = stdout.match(/^Pages:\s*(\d+)/m);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.min(MAX_RENDER_PAGES, n);
    }
  } catch {
    // fallback below
  }

  const text = pdfBytes.toString('latin1');
  const counts: number[] = [];
  const pagesRe = /\/Type\s*\/Pages\b[\s\S]{0,4096}?\/Count\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pagesRe.exec(text)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0 && n <= MAX_RENDER_PAGES) counts.push(n);
  }
  if (counts.length > 0) return Math.max(...counts);
  const leafMatches = text.match(/\/Type\s*\/Page\b(?!s)/g);
  if (leafMatches && leafMatches.length > 0) return Math.min(MAX_RENDER_PAGES, leafMatches.length);
  return 1;
}

async function renderSinglePageToPng(
  pdfBytes: Buffer,
  pageNumber: number,
  dpi: AllowedPdfDpi
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-pdf-page-'));
  const inputPath = path.join(tmpDir, 'input.pdf');
  const outPrefix = path.join(tmpDir, 'page');
  const outPng = `${outPrefix}.png`;
  try {
    await fs.writeFile(inputPath, pdfBytes);
    try {
      await execFileAsync(
        'pdftoppm',
        [
          '-png',
          '-r',
          String(dpi),
          '-f',
          String(pageNumber),
          '-l',
          String(pageNumber),
          '-singlefile',
          inputPath,
          outPrefix,
        ],
        { timeout: UNPACK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
      );
    } catch {
      await execFileAsync(
        'mutool',
        ['draw', '-F', 'png', '-r', String(dpi), '-o', outPng, inputPath, String(pageNumber)],
        { timeout: UNPACK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
      );
    }
    return await fs.readFile(outPng);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 登记 PDF 文档并预渲染第 1 页（默认 220 DPI），后续页码与高分辨率按需即时渲染缓存。
 */
export async function unpackPdfBufferToPages(
  pdfBytes: Buffer
): Promise<{ docId: string; totalPages: number }> {
  if (!isPdfMagicHeader(pdfBytes)) {
    throw new Error('无效的 PDF 文件（缺少 %PDF- 文件头）');
  }

  const docId = crypto.randomBytes(8).toString('hex');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `atlas-pdf-meta-${docId}-`));
  const inputPath = path.join(tmpDir, 'input.pdf');
  let totalPages = 1;
  try {
    await fs.writeFile(inputPath, pdfBytes);
    totalPages = await detectPdfTotalPages(inputPath, pdfBytes);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const firstPagePng = await renderSinglePageToPng(pdfBytes, 1, 220);
  const pageCache = new Map<string, Buffer>();
  pageCache.set('1@220', firstPagePng);

  const totalBytes = pdfBytes.byteLength + firstPagePng.byteLength;
  const record: UnpackedPdfRecord = {
    docId,
    pdfBytes,
    totalPages,
    pageCache,
    totalBytes,
    createdAt: Date.now(),
  };
  globalCachedBytes += totalBytes;
  touchDocLru(docId, record);
  return { docId, totalPages };
}

export function getUnpackedPdfMeta(docId: string): { docId: string; totalPages: number } | null {
  const rec = unpackedStore.get(docId);
  if (!rec) return null;
  touchDocLru(docId, rec);
  return { docId: rec.docId, totalPages: rec.totalPages };
}

export async function getUnpackedPdfPage(
  docId: string,
  page: number,
  requestedDpi?: unknown
): Promise<{ buffer: Buffer; totalPages: number; dpi: AllowedPdfDpi } | null> {
  const rec = unpackedStore.get(docId);
  if (!rec) return null;
  const pageNum = Math.floor(page);
  if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > rec.totalPages) return null;
  touchDocLru(docId, rec);

  const dpi = normalizePdfDpi(requestedDpi);
  const cacheKey = `${pageNum}@${dpi}`;
  const cached = rec.pageCache.get(cacheKey);
  if (cached) {
    rec.pageCache.delete(cacheKey);
    rec.pageCache.set(cacheKey, cached);
    return { buffer: cached, totalPages: rec.totalPages, dpi };
  }

  const rendered = await renderSinglePageToPng(rec.pdfBytes, pageNum, dpi);
  rec.pageCache.set(cacheKey, rendered);
  rec.totalBytes += rendered.byteLength;
  globalCachedBytes += rendered.byteLength;

  while (rec.pageCache.size > MAX_CACHED_PAGE_IMAGES) {
    const oldest = rec.pageCache.keys().next().value;
    if (!oldest) break;
    const evicted = rec.pageCache.get(oldest);
    rec.pageCache.delete(oldest);
    if (evicted) {
      rec.totalBytes = Math.max(rec.pdfBytes.byteLength, rec.totalBytes - evicted.byteLength);
      globalCachedBytes = Math.max(0, globalCachedBytes - evicted.byteLength);
    }
  }
  evictGlobalIfNeeded(docId);

  return { buffer: rendered, totalPages: rec.totalPages, dpi };
}
