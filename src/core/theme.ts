/**
 * @file theme.ts
 * @description Atlas Hybrid Canvas 主题管理纯逻辑模块（支持 light / dark / system，SSR 安全）。
 *
 * 提供：
 * - 主题偏好解析与 localStorage 安全读写；
 * - Canvas 2D 底层瓦片与全景大字暗色/亮色配色板；
 * - 透明背景注释在夜间模式下的低亮度文字自动提亮（仅影响渲染，不篡改蓝图源数据）。
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'atlas-hybrid-canvas:theme';

export interface CanvasThemePalette {
  canvasBg: string;
  gridStroke: string;
  gridCoordText: string;
  defaultEdgeStroke: string;
  macroNodeFillAlpha: string;
  macroTitleHalo: string;
  macroTitleFill: string;
  macroAnnHalo: string;
}

const LIGHT_CANVAS_PALETTE: CanvasThemePalette = {
  canvasBg: '#F8FAFC',
  gridStroke: 'rgba(148, 163, 184, 0.28)',
  gridCoordText: 'rgba(100, 116, 139, 0.55)',
  defaultEdgeStroke: '#64748B',
  macroNodeFillAlpha: '26',
  macroTitleHalo: 'rgba(255, 255, 255, 0.92)',
  macroTitleFill: '#0F172A',
  macroAnnHalo: 'rgba(248, 250, 252, 0.95)',
};

const DARK_CANVAS_PALETTE: CanvasThemePalette = {
  canvasBg: '#0B1120',
  gridStroke: 'rgba(148, 163, 184, 0.14)',
  gridCoordText: 'rgba(148, 163, 184, 0.45)',
  defaultEdgeStroke: '#94A3B8',
  macroNodeFillAlpha: '38',
  macroTitleHalo: 'rgba(11, 17, 32, 0.92)',
  macroTitleFill: '#F1F5F9',
  macroAnnHalo: 'rgba(11, 17, 32, 0.94)',
};

export function parseThemePreference(raw: unknown): ThemePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

export function toggleResolvedTheme(resolved: ResolvedTheme): ThemePreference {
  return resolved === 'dark' ? 'light' : 'dark';
}

export function loadThemePreference(): ThemePreference {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'system';
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (pref === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref);
    }
  } catch {
    // 忽略无痕/受限 iframe 下的存储异常
  }
}

export function getSystemPrefersDark(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function getCanvasThemePalette(isDark: boolean): CanvasThemePalette {
  return isDark ? DARK_CANVAS_PALETTE : LIGHT_CANVAS_PALETTE;
}

/** 计算 #RRGGBB 或 #RGB 的 WCAG 相对亮度（0..1），无法解析时返回 null */
export function parseHexLuminance(hex: string | undefined): number | null {
  if (!hex || typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  if (!trimmed.startsWith('#')) return null;
  const raw = trimmed.slice(1);
  let r: number;
  let g: number;
  let b: number;
  if (raw.length === 3) {
    r = parseInt(raw[0] + raw[0], 16);
    g = parseInt(raw[1] + raw[1], 16);
    b = parseInt(raw[2] + raw[2], 16);
  } else if (raw.length === 6) {
    r = parseInt(raw.slice(0, 2), 16);
    g = parseInt(raw.slice(2, 4), 16);
    b = parseInt(raw.slice(4, 6), 16);
  } else {
    return null;
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 夜间模式下，若背景注释无实色底块（透明或极低透明度）且文字本身为深色，
 * 自动在渲染层提亮为浅灰白，避免深色文字融进深色画布背景。
 */
export function adaptAnnotationTextColor(
  textColor: string,
  bgColor: string | undefined,
  bgOpacity: number | undefined,
  isDark: boolean
): string {
  if (!isDark) return textColor;
  const hasVisibleBg =
    Boolean(bgColor) &&
    bgColor !== 'transparent' &&
    (bgOpacity ?? 0.85) >= 0.25;
  if (hasVisibleBg) return textColor;
  const lum = parseHexLuminance(textColor);
  if (lum !== null && lum < 0.22) {
    return '#E2E8F0';
  }
  return textColor;
}
