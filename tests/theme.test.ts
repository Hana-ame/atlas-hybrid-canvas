import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptAnnotationTextColor,
  getCanvasThemePalette,
  getSystemPrefersDark,
  loadThemePreference,
  parseHexLuminance,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  toggleResolvedTheme,
} from '../src/core/theme.ts';

test('parseThemePreference & resolveTheme handle light, dark, system and invalid values', () => {
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(parseThemePreference('light'), 'light');
  assert.equal(parseThemePreference('system'), 'system');
  assert.equal(parseThemePreference('invalid'), 'system');
  assert.equal(parseThemePreference(null), 'system');

  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');

  assert.equal(toggleResolvedTheme('dark'), 'light');
  assert.equal(toggleResolvedTheme('light'), 'dark');
});

test('getCanvasThemePalette returns distinct light and dark Canvas 2D palettes', () => {
  const light = getCanvasThemePalette(false);
  const dark = getCanvasThemePalette(true);
  assert.equal(light.canvasBg, '#F8FAFC');
  assert.equal(dark.canvasBg, '#0B1120');
  assert.notEqual(light.macroTitleFill, dark.macroTitleFill);
  assert.notEqual(light.macroTitleHalo, dark.macroTitleHalo);
  assert.notEqual(light.gridStroke, dark.gridStroke);
});

test('adaptAnnotationTextColor lifts dark text on transparent background only in dark mode', () => {
  assert.equal(adaptAnnotationTextColor('#0F172A', undefined, undefined, false), '#0F172A');
  assert.equal(adaptAnnotationTextColor('#0F172A', 'transparent', 0, true), '#E2E8F0');
  assert.equal(adaptAnnotationTextColor('#1E293B', undefined, 0.85, true), '#E2E8F0');
  assert.equal(adaptAnnotationTextColor('#0F172A', '#FEF3C7', 0.9, true), '#0F172A');
  assert.equal(adaptAnnotationTextColor('#F8FAFC', 'transparent', 0, true), '#F8FAFC');

  const darkLum = parseHexLuminance('#0F172A');
  const lightLum = parseHexLuminance('#F8FAFC');
  assert.ok(darkLum !== null && darkLum < 0.05);
  assert.ok(lightLum !== null && lightLum > 0.9);
  assert.equal(parseHexLuminance('rgb(0,0,0)'), null);
});

test('theme storage helpers are SSR-safe when window is undefined', () => {
  assert.equal(loadThemePreference(), 'system');
  assert.equal(getSystemPrefersDark(), false);
  assert.doesNotThrow(() => saveThemePreference('dark'));
});
