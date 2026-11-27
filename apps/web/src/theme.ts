// Day / night theme for the web control plane.
//
// One switch, three preferences (`day` / `night` / `auto`), stored on the local
// machine only. The resolved theme is written to <html data-theme="day|night">
// so every colour in styles.css comes from the token block for that theme — no
// component hard-codes a colour, so nothing can end up half dark and half light.
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'day' | 'night' | 'auto';
export type ResolvedTheme = 'day' | 'night';

const STORAGE_KEY = 'daming.theme';
const DAY_QUERY = '(prefers-color-scheme: dark)';

function readPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'day' || raw === 'night' || raw === 'auto') return raw;
  } catch {
    // localStorage can be unavailable (private mode); fall back to auto.
  }
  return 'auto';
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === 'day' || preference === 'night') return preference;
  return window.matchMedia?.(DAY_QUERY).matches ? 'night' : 'day';
}

function apply(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Let the window chrome (Electron caption buttons / status bar) follow suit.
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', theme === 'night' ? 'dark' : 'light');
  else {
    const created = document.createElement('meta');
    created.setAttribute('name', 'color-scheme');
    created.setAttribute('content', theme === 'night' ? 'dark' : 'light');
    document.head.appendChild(created);
  }
  // Native caption buttons are painted by the shell, not by CSS: tell it which
  // theme is showing so a dark page gets dark buttons instead of a white block.
  const bridge = (window as { daming?: { setTheme?: (value: string) => Promise<unknown> } }).daming;
  void bridge?.setTheme?.(theme)?.catch?.(() => undefined);
}

export function useTheme(): {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof window === 'undefined' ? 'auto' : readPreference()
  );
  // The boot script has already resolved the real theme, so start from what the
  // document actually shows rather than recomputing (auto could otherwise
  // disagree for a frame with the pre-paint decision).
  const [theme, setTheme] = useState<ResolvedTheme>(() => {
    if (typeof window === 'undefined') return 'day';
    const painted = document.documentElement.dataset.theme;
    if (painted === 'day' || painted === 'night') return painted;
    return resolve(readPreference());
  });

  // Apply on mount and whenever the preference changes.
  useEffect(() => {
    const next = resolve(preference);
    setTheme(next);
    apply(next);
  }, [preference]);

  // `auto` follows the OS while the app is open.
  useEffect(() => {
    if (preference !== 'auto') return;
    const media = window.matchMedia?.(DAY_QUERY);
    if (!media) return;
    const onChange = () => {
      const next: ResolvedTheme = media.matches ? 'night' : 'day';
      setTheme(next);
      apply(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures; the in-memory preference still applies.
    }
    setPreferenceState(next);
  }, []);

  return { preference, theme, setPreference };
}

/** Cycle day -> night -> auto, for a compact top-bar control. */

export function nextPreference(current: ThemePreference): ThemePreference {
  return current === 'day' ? 'night' : current === 'night' ? 'auto' : 'day';
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  day: '白天',
  night: '暗夜',
  auto: '跟随系统'
};
