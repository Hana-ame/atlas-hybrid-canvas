import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUnpackedPdfMeta,
  getUnpackedPdfPage,
  isPdfMagicHeader,
  normalizePdfDpi,
  unpackPdfBufferToPages,
} from '../server/pdfUnpack.ts';

function buildMinimalTwoPagePdf(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('isPdfMagicHeader() validates %PDF- header and rejects non-PDF bytes', () => {
  assert.equal(isPdfMagicHeader(Buffer.from('%PDF-1.7\n...')), true);
  assert.equal(isPdfMagicHeader(Buffer.from('<html>not a pdf</html>')), false);
});

test('normalizePdfDpi() quantizes DPI into crisp 150/220/300/400 buckets', () => {
  assert.equal(normalizePdfDpi(100), 150);
  assert.equal(normalizePdfDpi(220), 220);
  assert.equal(normalizePdfDpi(300), 300);
  assert.equal(normalizePdfDpi(600), 400);
});

test('unpackPdfBufferToPages() unpacks a 2-page PDF and renders crisp higher-DPI PNGs on demand', async () => {
  const sample = buildMinimalTwoPagePdf();
  const unpacked = await unpackPdfBufferToPages(sample);
  assert.equal(unpacked.totalPages, 2);

  const meta = getUnpackedPdfMeta(unpacked.docId);
  assert.deepEqual(meta, { docId: unpacked.docId, totalPages: 2 });

  const page1Low = await getUnpackedPdfPage(unpacked.docId, 1, 150);
  const page1High = await getUnpackedPdfPage(unpacked.docId, 1, 300);
  const page2 = await getUnpackedPdfPage(unpacked.docId, 2, 220);
  const page3 = await getUnpackedPdfPage(unpacked.docId, 3, 220);
  assert.ok(page1Low && page1Low.buffer.byteLength > 100);
  assert.ok(page1High && page1High.buffer.byteLength > 100);
  assert.ok(page2 && page2.buffer.byteLength > 100);
  assert.equal(page1High.dpi, 300);
  const widthLow = page1Low.buffer.readUInt32BE(16);
  const widthHigh = page1High.buffer.readUInt32BE(16);
  assert.ok(widthHigh > widthLow, `Expected 300 DPI width (${widthHigh}) > 150 DPI width (${widthLow})`);
  assert.equal(page3, null);
});
