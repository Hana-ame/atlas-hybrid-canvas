/**
 * @file pdfHelper.ts
 * @description PDF 阅读控件辅助工具：
 * - 安全校验 PDF URL（仅放行 http/https/blob/相对 /api/pdf/，拦截 javascript:/data:text/html 等危险协议）；
 * - 构造支持 #page=N 页码跳转与 /api/proxy/binary 代理的 iframe 地址；
 * - 内置纯文本构造的最小合法 3 页 PDF（~1.1 KB），方便离线无网环境一键体验左右翻页与页码跳转。
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
 * 构造一份最小合法 3 页 PDF 字节流，用于在无外网/静态预览环境下直接测试翻页与页码跳转。
 */
export function createDemoSamplePdfBlobUrl(): string {
  const pageContents = [
    'BT /F1 24 Tf 60 720 Td (Atlas Hybrid Canvas - Page 1 / 3) Tj 0 -36 Td /F1 13 Tf (Use Prev / Next buttons or type a page number above.) Tj ET',
    'BT /F1 24 Tf 60 720 Td (Atlas Hybrid Canvas - Page 2 / 3) Tj 0 -36 Td /F1 13 Tf (Supports direct PDF URL, /api/proxy/binary, and local upload.) Tj ET',
    'BT /F1 24 Tf 60 720 Td (Atlas Hybrid Canvas - Page 3 / 3) Tj 0 -36 Td /F1 13 Tf (Page number is stored in vars.pdfPage and readable via widgets.inputs.) Tj ET',
  ];

  const objects: string[] = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n');
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 7 0 R >>\nendobj\n');
  objects.push('5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>\nendobj\n');
  for (let i = 0; i < 3; i++) {
    const stream = pageContents[i];
    objects.push(`${6 + i} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  }
  objects.push('9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  const blob = new Blob([pdf], { type: 'application/pdf' });
  return URL.createObjectURL(blob);
}

/**
 * 零依赖快速解析 PDF 总页数：优先匹配 /Type /Pages ... /Count N，回退统计 /Type /Page 节点数。
 *
 * 局限（有意为之，解析失败一律返回 null 让 UI 显示「共 ? 页」）：
 * - 走的是明文正则扫描，页对象被 FlateDecode 压进对象流（/ObjStm）的真实 PDF 扫不到；
 * - 因此 /Type /Pages 与 /Count 之间的间隔窗口放到 4KB，仍不保证覆盖所有生成器。
 * 需要精确页数时应在服务端用成熟解析库，而不是加大这里的正则。
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
