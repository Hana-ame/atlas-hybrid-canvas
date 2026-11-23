import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackoffDelayMs,
  DEFAULT_POLL_INTERVAL_SEC,
  extractJsonPath,
  formatPolledValue,
  isSafePollUrl,
  MAX_BACKOFF_DELAY_MS,
  MAX_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  normalizePollIntervalSec,
  normalizePollMethod,
} from '../src/core/apiPoller.ts';

test('normalizePollIntervalSec() clamps zero, negative, NaN, Infinity, and huge values safely', () => {
  assert.equal(normalizePollIntervalSec(0), DEFAULT_POLL_INTERVAL_SEC);
  assert.equal(normalizePollIntervalSec(-5), DEFAULT_POLL_INTERVAL_SEC);
  assert.equal(normalizePollIntervalSec('abc'), DEFAULT_POLL_INTERVAL_SEC);
  assert.equal(normalizePollIntervalSec(Infinity), DEFAULT_POLL_INTERVAL_SEC);
  assert.equal(normalizePollIntervalSec(1), MIN_POLL_INTERVAL_SEC);
  assert.equal(normalizePollIntervalSec(999999), MAX_POLL_INTERVAL_SEC);
  assert.equal(normalizePollIntervalSec('15.9'), 15);
});

test('isSafePollUrl() allows http/https and same-origin /api/ and blocks dangerous schemes', () => {
  assert.equal(isSafePollUrl('https://httpbin.org/get'), true);
  assert.equal(isSafePollUrl('http://example.com/metrics'), true);
  assert.equal(isSafePollUrl('/api/proxy/status'), true);
  assert.equal(isSafePollUrl(''), false);
  assert.equal(isSafePollUrl('javascript:alert(1)'), false);
  assert.equal(isSafePollUrl('data:application/json,{"a":1}'), false);
  assert.equal(isSafePollUrl('file:///etc/passwd'), false);
});

test('extractJsonPath() resolves nested fields & array indices and blocks prototype pollution', () => {
  const sample = {
    data: {
      price: 42.5,
      items: [{ name: 'alpha' }, { name: 'beta' }],
    },
  };
  assert.equal(extractJsonPath(sample, 'data.price'), 42.5);
  assert.equal(extractJsonPath(sample, 'data.items[1].name'), 'beta');
  assert.equal(extractJsonPath(sample, 'data.items[9].name'), undefined);
  assert.equal(extractJsonPath(sample, '__proto__.polluted'), undefined);
  assert.equal(extractJsonPath(sample, 'data.constructor.name'), undefined);
  assert.equal(extractJsonPath(sample, ''), sample);
});

test('computeBackoffDelayMs() applies bounded exponential backoff on consecutive failures', () => {
  assert.equal(computeBackoffDelayMs(5, 0), 5000);
  assert.equal(computeBackoffDelayMs(5, 1), 10000);
  assert.equal(computeBackoffDelayMs(5, 2), 20000);
  assert.equal(computeBackoffDelayMs(5, 4), 80000);
  assert.equal(computeBackoffDelayMs(5, 99), 80000);
  assert.equal(computeBackoffDelayMs(300, 3), MAX_BACKOFF_DELAY_MS);
});

test('formatPolledValue() & normalizePollMethod() handle undefined, null, objects, and truncation', () => {
  assert.equal(normalizePollMethod('post'), 'POST');
  assert.equal(normalizePollMethod('DELETE'), 'GET');
  assert.equal(formatPolledValue(undefined), '(未命中字段)');
  assert.equal(formatPolledValue(null), 'null');
  assert.equal(formatPolledValue({ ok: true }).includes('"ok": true'), true);
  const longStr = 'x'.repeat(200);
  assert.equal(formatPolledValue(longStr, 50).includes('已截断'), true);
});
