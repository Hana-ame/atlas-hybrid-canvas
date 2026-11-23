/**
 * @file pdfHelper.ts
 * @description PDF 逐页图片查看器辅助工具（零内置浏览器渲染）：
 * - 校验 PDF URL 安全性；
 * - 构造带动态高分 DPI 档位（150/220/300/400）的服务端逐页图片地址；
 * - 零依赖 PDF 页数探测。
 */

export function normalizePdfPage(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(9999, n);
}

export function isSafePdfUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('/api/pdf/') ||
    trimmed.startsWith('/api/proxy/binary')
  ) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isUnpackedPdfTemplate(rawUrl: string): boolean {
  return /^\/api\/pdf\/[a-zA-Z0-9_-]+\/page\/\{page\}$/.test(rawUrl.trim());
}

export function pickPdfRenderDpi(targetPixelWidth: number): 150 | 220 | 300 | 400 {
  if (!Number.isFinite(targetPixelWidth) || targetPixelWidth <= 1050) return 150;
  if (targetPixelWidth <= 1650) return 220;
  if (targetPixelWidth <= 2450) return 300;
  return 400;
}

export function buildPdfPageImageUrl(rawUrl: string, page: number, dpi?: number): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const safePage = normalizePdfPage(page);
  let base: string | null = null;
  if (isUnpackedPdfTemplate(trimmed)) {
    base = trimmed.replace('{page}', String(safePage));
  } else {
    const match = trimmed.match(/^\/api\/pdf\/([a-zA-Z0-9_-]+)(?:\/page\/\d+)?$/);
    if (match) {
      base = `/api/pdf/${match[1]}/page/${safePage}`;
    }
  }
  if (!base) return null;
  if (dpi && Number.isFinite(dpi)) {
    return `${base}?dpi=${Math.round(dpi)}`;
  }
  return base;
}

export function countPdfPagesFromBytes(bytes: Uint8Array): number | null {
  try {
    const text = new TextDecoder('latin1').decode(bytes);
    const counts: number[] = [];
    const pagesRe = /\/Type\s*\/Pages\b[\s\S]{0,4096}?\/Count\s+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = pagesRe.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n <= 9999) counts.push(n);
    }
    if (counts.length > 0) return Math.max(...counts);

    const leafMatches = text.match(/\/Type\s*\/Page\b(?!s)/g);
    if (leafMatches && leafMatches.length > 0) return leafMatches.length;
    return null;
  } catch {
    return null;
  }
}
