import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdfIframeSrc, countPdfPagesFromBytes, isSafePdfUrl, normalizePdfPage } from '../src/core/pdfHelper.ts';

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

test('buildPdfIframeSrc() appends #page=N and routes remote URLs via /api/proxy/binary when useProxy is true', () => {
  assert.equal(
    buildPdfIframeSrc('https://example.com/a.pdf#page=1', 5, false),
    'https://example.com/a.pdf#page=5&view=FitH'
  );
  assert.equal(
    buildPdfIframeSrc('https://example.com/a.pdf', 7, true),
    '/api/proxy/binary?url=https%3A%2F%2Fexample.com%2Fa.pdf#page=7&view=FitH'
  );
  assert.equal(buildPdfIframeSrc('javascript:alert(1)', 1, true), null);
});

test('countPdfPagesFromBytes() extracts total page count from /Type /Pages /Count N', () => {
  const sample = new TextEncoder().encode('%PDF-1.4\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj');
  assert.equal(countPdfPagesFromBytes(sample), 3);
});
