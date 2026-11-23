import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPdfPageImageUrl,
  countPdfPagesFromBytes,
  isSafePdfUrl,
  isUnpackedPdfTemplate,
  normalizePdfPage,
} from '../src/core/pdfHelper.ts';

test('normalizePdfPage() clamps invalid, negative, and oversized page numbers', () => {
  assert.equal(normalizePdfPage(0), 1);
  assert.equal(normalizePdfPage(-5), 1);
  assert.equal(normalizePdfPage('3.9'), 3);
  assert.equal(normalizePdfPage('abc'), 1);
  assert.equal(normalizePdfPage(999999), 9999);
});

test('isSafePdfUrl() allows http/https/blob/local server proxy and rejects javascript:/data: schemes', () => {
  assert.equal(isSafePdfUrl('https://example.com/doc.pdf'), true);
  assert.equal(isSafePdfUrl('blob:https://example.com/123'), true);
  assert.equal(isSafePdfUrl('/api/pdf/abc123'), true);
  assert.equal(isSafePdfUrl('javascript:alert(1)'), false);
  assert.equal(isSafePdfUrl('data:text/html,<script>alert(1)</script>'), false);
});

test('isUnpackedPdfTemplate() & buildPdfPageImageUrl() resolve per-page PNG URLs safely', () => {
  assert.equal(isUnpackedPdfTemplate('/api/pdf/a1b2c3d4/page/{page}'), true);
  assert.equal(isUnpackedPdfTemplate('https://example.com/a.pdf'), false);
  assert.equal(buildPdfPageImageUrl('/api/pdf/a1b2c3d4/page/{page}', 3), '/api/pdf/a1b2c3d4/page/3');
  assert.equal(buildPdfPageImageUrl('/api/pdf/a1b2c3d4', 0), '/api/pdf/a1b2c3d4/page/1');
  assert.equal(buildPdfPageImageUrl('https://example.com/a.pdf', 2), null);
});

test('countPdfPagesFromBytes() extracts total page count from /Type /Pages /Count N', () => {
  const sample = new TextEncoder().encode('%PDF-1.4\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj');
  assert.equal(countPdfPagesFromBytes(sample), 3);
});
