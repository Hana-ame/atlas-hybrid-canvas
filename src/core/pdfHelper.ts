/**
 * @file pdfHelper.ts
 * @description PDF 阅读控件辅助工具：
 * - 安全校验 PDF URL（放行 http/https 外链、服务端 /api/pdf/ 与 /api/proxy/binary 及合法 blob:，拒绝 javascript:/data:）；
 * - 构造支持 #page=N 页码跳转与 /api/proxy/binary 代理的 iframe 地址；
 * - 提供零依赖 PDF 页数解析（仅支持未压缩页树，压缩流 /ObjStm PDF 返回 null 由 UI 显示共 ? 页）。
 */

export function normalizePdfPage(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(9999, n);
}

export function isSafePdfUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('blob:') || trimmed.startsWith('/api/pdf/') || trimmed.startsWith('/api/proxy/binary')) {
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
 * 生成带页码锚点的 PDF iframe 地址；开启 useProxy 时对 http/https 外链自动走服务端 /api/proxy/binary。
 */
export function buildPdfIframeSrc(rawUrl: string, page: number, useProxy: boolean): string | null {
  const trimmed = rawUrl.trim();
  if (!isSafePdfUrl(trimmed)) return null;
  const safePage = normalizePdfPage(page);
  const baseNoHash = trimmed.split('#')[0];

  const isRemoteHttp = /^https?:\/\//i.test(baseNoHash);
  const resolvedBase =
    useProxy && isRemoteHttp
      ? `/api/proxy/binary?url=${encodeURIComponent(baseNoHash)}`
      : baseNoHash;

  return `${resolvedBase}#page=${safePage}&view=FitH`;
}

/**
 * 零依赖快速解析 PDF 总页数：优先在 4KB 窗口内匹配 /Type /Pages ... /Count N，回退统计 /Type /Page 节点数。
 * 局限：若真实世界 PDF 使用 FlateDecode 将页对象压进 /ObjStm 压缩流，明文正则扫不到，会返回 null 由 UI 展示「共 ? 页」。
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
