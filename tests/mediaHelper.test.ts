import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSliderValue,
  formatSliderValue,
  isSafeImageUrl,
  isSafeVideoUrl,
  mapPadPointerToValues,
  mapPadValuesToPercent,
  resolveImageButtonSrc,
  resolveImageButtonState,
} from '../src/core/mediaHelper.ts';
import { sanitizeEphemeralBlobVars } from '../src/core/layeredStore.ts';

test('isSafeImageUrl() allows https/http/blob/api/data:image and rejects dangerous schemes', () => {
  assert.equal(isSafeImageUrl('https://example.com/photo.png'), true);
  assert.equal(isSafeImageUrl('http://example.com/a.jpg'), true);
  assert.equal(isSafeImageUrl('/api/pdf/abc/page/1'), true);
  assert.equal(isSafeImageUrl('blob:http://localhost:8787/1234'), true);
  assert.equal(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isSafeImageUrl('data:image/svg+xml;utf8,<svg></svg>'), true);

  assert.equal(isSafeImageUrl(''), false);
  assert.equal(isSafeImageUrl('javascript:alert(1)'), false);
  assert.equal(isSafeImageUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeImageUrl('vbscript:msgbox(1)'), false);
});

test('isSafeVideoUrl() allows https/http/blob/api/data:video and rejects dangerous schemes', () => {
  assert.equal(isSafeVideoUrl('https://example.com/demo.mp4'), true);
  assert.equal(isSafeVideoUrl('http://example.com/demo.webm'), true);
  assert.equal(isSafeVideoUrl('/api/proxy/binary?url=foo'), true);
  assert.equal(isSafeVideoUrl('blob:http://localhost:8787/vid-1'), true);
  assert.equal(isSafeVideoUrl('data:video/mp4;base64,AAAA'), true);

  assert.equal(isSafeVideoUrl(''), false);
  assert.equal(isSafeVideoUrl('javascript:alert(1)'), false);
  assert.equal(isSafeVideoUrl('data:text/html;base64,PGh0bWw+'), false);
});

test('clampSliderValue() snaps cleanly to step, clamps bounds, and avoids float drift', () => {
  assert.equal(clampSliderValue(50, 0, 100, 1), 50);
  assert.equal(clampSliderValue(-20, 0, 100, 1), 0);
  assert.equal(clampSliderValue(150, 0, 100, 1), 100);
  assert.equal(clampSliderValue('not-a-num', 10, 50, 5), 10);
  // 浮点步进精度
  assert.equal(clampSliderValue(0.30000000000000004, 0, 1, 0.1), 0.3);
  assert.equal(clampSliderValue(0.26, 0, 1, 0.1), 0.3);
  // 反向边界自动归一化
  assert.equal(clampSliderValue(15, 20, 10, 1), 15);
  assert.equal(clampSliderValue(5, 20, 10, 1), 10);
});

test('formatSliderValue() formats numeric value with precision and optional unit', () => {
  assert.equal(formatSliderValue(75, '%', 1), '75%');
  assert.equal(formatSliderValue(1.5, '×', 0.5), '1.5×');
  assert.equal(formatSliderValue(0.25, '', 0.05), '0.25');
});

test('sanitizeEphemeralBlobVars() clears stale blob: imageUrl and videoUrl while preserving data: and https:', () => {
  const cleaned = sanitizeEphemeralBlobVars({
    n1: { imageUrl: 'blob:http://localhost:8787/img1', videoUrl: 'blob:http://localhost:8787/vid1' },
    n2: { imageUrl: 'data:image/png;base64,AAA', videoUrl: 'https://cdn.example.com/a.mp4' },
  });
  assert.equal(cleaned.n1.imageUrl, '');
  assert.equal(cleaned.n1.videoUrl, '');
  assert.equal(cleaned.n2.imageUrl, 'data:image/png;base64,AAA');
  assert.equal(cleaned.n2.videoUrl, 'https://cdn.example.com/a.mp4');
});

test('mapPadPointerToValues() & mapPadValuesToPercent() map 2D Pad coordinates accurately with invertY', () => {
  const cfg = { minX: -100, maxX: 100, stepX: 1, minY: -100, maxY: 100, stepY: 1, invertY: true };
  assert.deepEqual(mapPadPointerToValues(0.5, 0.5, cfg), { x: 0, y: 0 });
  assert.deepEqual(mapPadPointerToValues(0, 0, cfg), { x: -100, y: 100 });
  assert.deepEqual(mapPadPointerToValues(1, 1, cfg), { x: 100, y: -100 });
  assert.deepEqual(mapPadPointerToValues(1.5, -0.5, cfg), { x: 100, y: 100 });

  assert.deepEqual(mapPadValuesToPercent(0, 0, cfg), { leftPct: 50, topPct: 50 });
  assert.deepEqual(mapPadValuesToPercent(-100, 100, cfg), { leftPct: 0, topPct: 0 });
  assert.deepEqual(mapPadValuesToPercent(100, -100, cfg), { leftPct: 100, topPct: 100 });
});

test('resolveImageButtonState() enforces priority click > hover > on > off', () => {
  assert.equal(resolveImageButtonState({ isOn: false, hovered: false, pressed: false }), 'off');
  assert.equal(resolveImageButtonState({ isOn: true, hovered: false, pressed: false }), 'on');
  assert.equal(resolveImageButtonState({ isOn: true, hovered: true, pressed: false }), 'hover');
  assert.equal(resolveImageButtonState({ isOn: false, hovered: true, pressed: true }), 'click');
});

test('resolveImageButtonSrc() resolves safe URLs per state and rejects dangerous protocols', () => {
  const sources = {
    offImage: 'https://cdn.example.com/off.png',
    onImage: 'https://cdn.example.com/on.png',
    hoverImage: 'https://cdn.example.com/hover.png',
    clickImage: 'https://cdn.example.com/click.png',
  };
  assert.equal(resolveImageButtonSrc(sources, 'off', false), 'https://cdn.example.com/off.png');
  assert.equal(resolveImageButtonSrc(sources, 'on', true), 'https://cdn.example.com/on.png');
  assert.equal(resolveImageButtonSrc(sources, 'hover', false), 'https://cdn.example.com/hover.png');
  assert.equal(resolveImageButtonSrc(sources, 'click', true), 'https://cdn.example.com/click.png');

  // 危险协议被拦截并安全回退到合法贴图
  const unsafe = {
    offImage: 'https://cdn.example.com/off.png',
    onImage: 'https://cdn.example.com/on.png',
    hoverImage: 'javascript:alert(1)',
    clickImage: 'data:text/html,<script>alert(1)</script>',
  };
  assert.equal(resolveImageButtonSrc(unsafe, 'hover', true), 'https://cdn.example.com/on.png');
  assert.equal(resolveImageButtonSrc(unsafe, 'click', false), 'https://cdn.example.com/off.png');
});
