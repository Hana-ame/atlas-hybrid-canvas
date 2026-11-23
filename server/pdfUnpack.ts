/**
 * @file pdfUnpack.ts
 * @description 服务端 PDF 逐页解包引擎：
 * - 使用 pdftoppm（优先）或 mutool（兜底）将 PDF 光栅化为逐页 PNG 图片；
 * - 全程使用 execFile 传参数组，杜绝命令注入；
 * - 内置 LRU 缓存（最多 15 份且总计不超过 256MB），单页按需下发 image/png。
 *
 * 运行前提：宿主机必须提供 `pdftoppm`（poppler-utils）或 `mutool`（mupdf-tools）。
 * 这两个是系统级二进制，无法通过 npm 安装，缺失时本模块所有解包请求都会失败。
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_UNPACKED_DOCS = 15;
const MAX_RENDER_PAGES = 200;
// 只按「份数」限制是不够的：200 页 144DPI 的彩色 PDF 每页可达 2-4MB，单份就能到 400-800MB，
// 15 份叠加轻松突破 Node 默认堆上限直接 OOM。必须再加一道总字节上限，按实际占用逐出。
const MAX_UNPACKED_TOTAL_BYTES = 256 * 1024 * 1024;
const RENDER_DPI = '144';
const UNPACK_TIMEOUT_MS = 45_000;

interface UnpackedPdfRecord {
  docId: string;
  pages: Buffer[];
  totalPages: number;
  createdAt: number;
  bytes: number;
}

const unpackedStore = new Map<string, UnpackedPdfRecord>();

function sumRecordBytes(record: UnpackedPdfRecord): number {
  let total = 0;
  for (const p of record.pages) total += p.byteLength;
  return total;
}

function evictUntilWithinBudget(keepDocId: string): void {
  let total = 0;
  for (const rec of unpackedStore.values()) total += rec.bytes;
  // 迭代顺序即插入顺序（最久未用在前），逐出直到同时满足份数与字节两条上限。
  for (const [id, rec] of unpackedStore) {
    if (unpackedStore.size <= MAX_UNPACKED_DOCS && total <= MAX_UNPACKED_TOTAL_BYTES) break;
    if (id === keepDocId) continue; // 刚写入的这份本身超大时保留，否则会一进来就被逐出
    total -= rec.bytes;
    unpackedStore.delete(id);
  }
}

function touchLru(docId: string, record: UnpackedPdfRecord): void {
  unpackedStore.delete(docId);
  unpackedStore.set(docId, record);
  evictUntilWithinBudget(docId);
}

export function isPdfMagicHeader(buf: Buffer): boolean {
  if (!buf || buf.byteLength < 5) return false;
  const head = buf.subarray(0, Math.min(1024, buf.byteLength)).toString('latin1');
  return head.includes('%PDF-');
}

function numericPageSort(a: string, b: string): number {
  const ma = a.match(/(\d+)\.png$/i);
  const mb = b.match(/(\d+)\.png$/i);
  const na = ma ? Number(ma[1]) : 0;
  const nb = mb ? Number(mb[1]) : 0;
  return na - nb;
}

async function renderWithPdftoppm(inputPath: string, outPrefix: string): Promise<void> {
  await execFileAsync(
    'pdftoppm',
    ['-png', '-r', RENDER_DPI, '-f', '1', '-l', String(MAX_RENDER_PAGES), inputPath, outPrefix],
    { timeout: UNPACK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
  );
}

async function renderWithMutool(inputPath: string, outPattern: string): Promise<void> {
  await execFileAsync(
    'mutool',
    ['draw', '-F', 'png', '-r', RENDER_DPI, '-o', outPattern, inputPath, `1-${MAX_RENDER_PAGES}`],
    { timeout: UNPACK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
  );
}

/**
 * 将 PDF 二进制内容解包为逐页 PNG 图片并写入 LRU 缓存。
 */
export async function unpackPdfBufferToPages(
  pdfBytes: Buffer
): Promise<{ docId: string; totalPages: number }> {
  if (!isPdfMagicHeader(pdfBytes)) {
    throw new Error('无效的 PDF 文件（缺少 %PDF- 文件头）');
  }

  const docId = crypto.randomBytes(8).toString('hex');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `atlas-pdf-${docId}-`));
  const inputPath = path.join(tmpDir, 'input.pdf');

  try {
    await fs.writeFile(inputPath, pdfBytes);
    const outPrefix = path.join(tmpDir, 'page');
    const outPattern = path.join(tmpDir, 'page-%04d.png');

    try {
      await renderWithPdftoppm(inputPath, outPrefix);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        await renderWithMutool(inputPath, outPattern);
      } else {
        try {
          await renderWithMutool(inputPath, outPattern);
        } catch {
          throw new Error(`PDF 解包失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const entries = (await fs.readdir(tmpDir))
      .filter((f) => /^page[-_]?\d+\.png$/i.test(f))
      .sort(numericPageSort);

    if (entries.length === 0) {
      throw new Error('PDF 未能解包出任何页面图片');
    }

    const pages: Buffer[] = [];
    for (const file of entries) {
      pages.push(await fs.readFile(path.join(tmpDir, file)));
    }

    const bytes = sumRecordBytes({ docId, pages, totalPages: pages.length, createdAt: 0, bytes: 0 });
    // 单份就超出总预算时直接拒绝：收进来也会立刻被逐出，不如明确告知用户降低页数/DPI。
    if (bytes > MAX_UNPACKED_TOTAL_BYTES) {
      throw new Error(
        `PDF 解包后体积过大（${Math.round(bytes / 1024 / 1024)}MB，超过 ${
          MAX_UNPACKED_TOTAL_BYTES / 1024 / 1024
        }MB 缓存上限），请拆分文件或降低页数后重试`
      );
    }

    const record: UnpackedPdfRecord = {
      docId,
      pages,
      totalPages: pages.length,
      createdAt: Date.now(),
      bytes,
    };
    touchLru(docId, record);
    return { docId, totalPages: pages.length };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function getUnpackedPdfMeta(docId: string): { docId: string; totalPages: number } | null {
  const rec = unpackedStore.get(docId);
  if (!rec) return null;
  touchLru(docId, rec);
  return { docId: rec.docId, totalPages: rec.totalPages };
}

export function getUnpackedPdfPage(
  docId: string,
  page: number
): { buffer: Buffer; totalPages: number } | null {
  const rec = unpackedStore.get(docId);
  if (!rec) return null;
  const idx = Math.floor(page) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= rec.pages.length) return null;
  touchLru(docId, rec);
  return { buffer: rec.pages[idx], totalPages: rec.totalPages };
}
