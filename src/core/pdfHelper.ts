/**
 * @file pdfHelper.ts
 * @description PDF 逐页图片查看器辅助工具（彻底移除内置浏览器渲染逻辑）：
 * - 校验 PDF URL 安全性（放行 http/https 外链、服务端 /api/pdf/、/api/proxy/binary 及合法 blob:，拒绝 javascript:/data:）；
 * - 构造服务端逐页图片地址（/api/pdf/:docId/page/:page）；
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

/**
 * 判断地址是否已是服务端解包后的逐页图片模板（/api/pdf/:docId/page/{page}）。
 */
export function isUnpackedPdfTemplate(rawUrl: string): boolean {
  return /^\/api\/pdf\/[a-zA-Z0-9_-]+\/page\/\{page\}$/.test(rawUrl.trim());
}

/**
 * 根据服务端解包模板（/api/pdf/:docId/page/{page}）生成指定页的图片地址。
 */
export function buildPdfPageImageUrl(rawUrl: string, page: number): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const safePage = normalizePdfPage(page);
  if (isUnpackedPdfTemplate(trimmed)) {
    return trimmed.replace('{page}', String(safePage));
  }
  const match = trimmed.match(/^\/api\/pdf\/([a-zA-Z0-9_-]+)(?:\/page\/\d+)?$/);
  if (match) {
    return `/api/pdf/${match[1]}/page/${safePage}`;
  }
  return null;
}

/**
 * 零依赖快速解析 PDF 总页数：优先在 4KB 窗口内匹配 /Type /Pages ... /Count N，回退统计 /Type /Page 节点数。
 */
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
