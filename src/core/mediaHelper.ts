/**
 * @file mediaHelper.ts
 * @description 图片节点、视频节点与拖动条控件的纯函数工具（URL 安全校验、滑块数值步进与格式化）。
 */

const SAFE_INLINE_SVG_RE = /^data:image\/svg\+xml;/i;

/** 校验图片 URL 安全性（纯外链策略）：允许 http/https、同源 /api/ 与轻量内置 data:image/svg+xml，拒绝 blob: 与大二进制 data:。 */
export function isSafeImageUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith('/api/')) return true;
  if (SAFE_INLINE_SVG_RE.test(s) && s.length <= 16_384) return true;
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 校验视频 URL 安全性（纯外链策略）：仅允许 http/https 与同源 /api/，拒绝 blob: 与 data:，防止大视频驻留浏览器内存。 */
export function isSafeVideoUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith('/api/')) return true;
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 计算小数精度位数，避免浮点步进产生 0.30000000000000004 漂移。 */
export function getStepPrecision(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  if (s.includes('e-')) {
    const exp = Number(s.split('e-')[1]);
    return Number.isFinite(exp) ? Math.min(6, Math.max(0, exp)) : 0;
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, s.length - dot - 1);
}

/** 归一化拖动条配置并按步长对齐到 [min, max]。 */
export function clampSliderValue(raw: unknown, minRaw = 0, maxRaw = 100, stepRaw = 1): number {
  const a = Number.isFinite(minRaw) ? minRaw : 0;
  const b = Number.isFinite(maxRaw) ? maxRaw : 100;
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;

  const num = typeof raw === 'number' ? raw : Number(raw);
  const safeNum = Number.isFinite(num) ? num : min;
  const clamped = Math.min(max, Math.max(min, safeNum));
  const steps = Math.round((clamped - min) / step);
  const snapped = Math.min(max, Math.max(min, min + steps * step));
  const precision = Math.max(getStepPrecision(step), getStepPrecision(min));
  return Number(snapped.toFixed(precision));
}

/** 格式化拖动条显示文本（可选单位）。 */
export function formatSliderValue(value: number, unit?: string, step = 1): string {
  const precision = getStepPrecision(step);
  const formatted = Number.isFinite(value) ? value.toFixed(precision) : '0';
  const suffix = unit ? unit.trim() : '';
  return suffix ? `${formatted}${suffix}` : formatted;
}

export interface Pad2DRangeConfig {
  minX?: number;
  maxX?: number;
  stepX?: number;
  minY?: number;
  maxY?: number;
  stepY?: number;
  invertY?: boolean;
}

/** 将 2D Pad 内归一化坐标 nx, ny ∈ [0, 1] 映射为对齐步长后的 (x, y) 数值。 */
export function mapPadPointerToValues(
  nxRaw: number,
  nyRaw: number,
  cfg: Pad2DRangeConfig = {}
): { x: number; y: number } {
  const minX = cfg.minX ?? -100;
  const maxX = cfg.maxX ?? 100;
  const stepX = cfg.stepX ?? 1;
  const minY = cfg.minY ?? -100;
  const maxY = cfg.maxY ?? 100;
  const stepY = cfg.stepY ?? 1;
  const invertY = cfg.invertY !== false;

  const nx = Math.min(1, Math.max(0, Number.isFinite(nxRaw) ? nxRaw : 0.5));
  const ny = Math.min(1, Math.max(0, Number.isFinite(nyRaw) ? nyRaw : 0.5));
  const loX = Math.min(minX, maxX);
  const hiX = Math.max(minX, maxX);
  const loY = Math.min(minY, maxY);
  const hiY = Math.max(minY, maxY);

  const rawX = loX + nx * (hiX - loX);
  const rawY = invertY ? hiY - ny * (hiY - loY) : loY + ny * (hiY - loY);
  return {
    x: clampSliderValue(rawX, loX, hiX, stepX),
    y: clampSliderValue(rawY, loY, hiY, stepY),
  };
}

/** 将 (x, y) 数值映射为 2D Pad 上的百分比定位 (leftPct, topPct) ∈ [0, 100]。 */
export function mapPadValuesToPercent(
  x: number,
  y: number,
  cfg: Pad2DRangeConfig = {}
): { leftPct: number; topPct: number } {
  const minX = cfg.minX ?? -100;
  const maxX = cfg.maxX ?? 100;
  const minY = cfg.minY ?? -100;
  const maxY = cfg.maxY ?? 100;
  const invertY = cfg.invertY !== false;

  const loX = Math.min(minX, maxX);
  const hiX = Math.max(minX, maxX);
  const loY = Math.min(minY, maxY);
  const hiY = Math.max(minY, maxY);

  const cx = Math.min(hiX, Math.max(loX, Number.isFinite(x) ? x : (loX + hiX) / 2));
  const cy = Math.min(hiY, Math.max(loY, Number.isFinite(y) ? y : (loY + hiY) / 2));

  const nx = hiX > loX ? (cx - loX) / (hiX - loX) : 0.5;
  const ny = hiY > loY ? (invertY ? (hiY - cy) / (hiY - loY) : (cy - loY) / (hiY - loY)) : 0.5;
  return {
    leftPct: Math.min(100, Math.max(0, nx * 100)),
    topPct: Math.min(100, Math.max(0, ny * 100)),
  };
}

export type ImageButtonState = 'off' | 'on' | 'hover' | 'click';

export interface ImageButtonSources {
  offImage?: string;
  onImage?: string;
  hoverImage?: string;
  clickImage?: string;
}

/** 解析四态图片按钮当前应处的状态（优先级：click > hover > on > off）。 */
export function resolveImageButtonState(flags: {
  isOn: boolean;
  hovered: boolean;
  pressed: boolean;
}): ImageButtonState {
  if (flags.pressed) return 'click';
  if (flags.hovered) return 'hover';
  return flags.isOn ? 'on' : 'off';
}

/** 按当前状态选择安全合法的贴图 URL，缺失时优雅回退到 on/off 贴图。 */
export function resolveImageButtonSrc(
  sources: ImageButtonSources,
  state: ImageButtonState,
  isOn: boolean
): string {
  const pick = (u?: string): string => (u && isSafeImageUrl(u) ? u.trim() : '');
  const baseFallback = isOn ? pick(sources.onImage) || pick(sources.offImage) : pick(sources.offImage) || pick(sources.onImage);
  if (state === 'click') return pick(sources.clickImage) || baseFallback;
  if (state === 'hover') return pick(sources.hoverImage) || baseFallback;
  if (state === 'on') return pick(sources.onImage) || pick(sources.offImage);
  return pick(sources.offImage) || pick(sources.onImage);
}
