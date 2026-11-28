import { useCallback, useEffect, useState } from 'react';
import {
  getSystemPrefersDark,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  toggleResolvedTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '../core/theme';

export interface UseThemeResult {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  isDark: boolean;
  setPreference: (next: ThemePreference) => void;
  toggleTheme: () => ResolvedTheme;
  resetToSystem: () => ResolvedTheme;
}

function applyThemeToDocument(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => loadThemePreference());
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => getSystemPrefersDark());

  const resolvedTheme = resolveTheme(preference, systemPrefersDark);
  const isDark = resolvedTheme === 'dark';

  useEffect(() => {
    applyThemeToDocument(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (ev: MediaQueryListEvent) => {
      setSystemPrefersDark(ev.matches);
    };
    setSystemPrefersDark(mq.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    saveThemePreference(next);
  }, []);

  const toggleTheme = useCallback((): ResolvedTheme => {
    const nextPref = toggleResolvedTheme(resolvedTheme);
    setPreferenceState(nextPref);
    saveThemePreference(nextPref);
    return nextPref === 'dark' ? 'dark' : 'light';
  }, [resolvedTheme]);

  const resetToSystem = useCallback((): ResolvedTheme => {
    setPreferenceState('system');
    saveThemePreference('system');
    return resolveTheme('system', systemPrefersDark);
  }, [systemPrefersDark]);

  return {
    preference,
    resolvedTheme,
    isDark,
    setPreference,
    toggleTheme,
    resetToSystem,
  };
}
