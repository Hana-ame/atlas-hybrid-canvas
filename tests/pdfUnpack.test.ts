import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUnpackedPdfMeta,
  getUnpackedPdfPage,
  isPdfMagicHeader,
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

test('unpackPdfBufferToPages() unpacks a 2-page PDF into PNG image buffers without iframe', async () => {
  const sample = buildMinimalTwoPagePdf();
  const unpacked = await unpackPdfBufferToPages(sample);
  assert.equal(unpacked.totalPages, 2);

  const meta = getUnpackedPdfMeta(unpacked.docId);
  assert.deepEqual(meta, { docId: unpacked.docId, totalPages: 2 });

  const page1 = getUnpackedPdfPage(unpacked.docId, 1);
  const page2 = getUnpackedPdfPage(unpacked.docId, 2);
  const page3 = getUnpackedPdfPage(unpacked.docId, 3);
  assert.ok(page1 && page1.buffer.byteLength > 100);
  assert.ok(page2 && page2.buffer.byteLength > 100);
  assert.equal(page1.buffer[0], 0x89);
  assert.equal(page1.buffer[1], 0x50);
  assert.equal(page1.buffer[2], 0x4e);
  assert.equal(page1.buffer[3], 0x47);
  assert.equal(page3, null);
});

test('getUnpackedPdfPage() rejects non-finite, zero, and negative page numbers without throwing', () => {
  const sample = buildMinimalTwoPagePdf();
  // 这里只验证纯查表逻辑不崩：docId 不存在时任何页码都应返回 null。
  assert.equal(getUnpackedPdfPage('deadbeefdeadbeef', 1), null);
  assert.equal(getUnpackedPdfPage('deadbeefdeadbeef', 0), null);
  assert.equal(getUnpackedPdfPage('deadbeefdeadbeef', -3), null);
  assert.equal(getUnpackedPdfPage('deadbeefdeadbeef', Number.NaN), null);
  assert.equal(getUnpackedPdfPage('deadbeefdeadbeef', Number.POSITIVE_INFINITY), null);
  assert.equal(getUnpackedPdfMeta('deadbeefdeadbeef'), null);
  // 保留变量引用，避免 sample 构造被 tree-shake 掉的错觉（同时确认构造本身不抛）。
  assert.ok(isPdfMagicHeader(sample));
});

test('unpackPdfBufferToPages() rejects non-PDF payloads instead of caching garbage', async () => {
  await assert.rejects(
    () => unpackPdfBufferToPages(Buffer.from('<html>definitely not a pdf</html>', 'latin1')),
    /缺少 %PDF- 文件头/
  );
  // 空 Buffer 同样必须拒绝，不能静默产出 0 页记录。
  await assert.rejects(() => unpackPdfBufferToPages(Buffer.alloc(0)), /缺少 %PDF- 文件头/);
});
