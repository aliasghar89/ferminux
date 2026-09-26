// Per-device display and lock preferences. Losing them only resets the view:
// every read and write is guarded, and the defaults are the safe ones.

import { useEffect, useState } from 'react';
import { IDLE_LOCK_MS } from '../config.ts';

const THEME_KEY = 'ferminux.wallet.theme.v1';
const LOCK_KEY = 'ferminux.wallet.lockAfter.v1';

export type Theme = 'dark' | 'light';

/** Auto-lock choices, in minutes. The default stays config's IDLE_LOCK_MS (15). */
export const LOCK_CHOICES = [1, 5, 15, 30, 60] as const;

function get(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export function loadTheme(): Theme {
  return get(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#000000');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}

export function saveTheme(theme: Theme): void {
  set(THEME_KEY, theme);
  applyTheme(theme);
  emit();
}

export function loadLockMs(): number {
  const n = Number(get(LOCK_KEY));
  return (LOCK_CHOICES as readonly number[]).includes(n) ? n * 60_000 : IDLE_LOCK_MS;
}

export function saveLockMinutes(minutes: number): void {
  if (!(LOCK_CHOICES as readonly number[]).includes(minutes)) return;
  set(LOCK_KEY, String(minutes));
  emit();
}

/** Re-render when a preference changes (in this tab). */
function usePref<T>(read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const f = () => setValue(read());
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, [read]);
  return value;
}

export const useTheme = (): Theme => usePref(loadTheme);
export const useLockMs = (): number => usePref(loadLockMs);

// Before the first render: the chosen theme, so a light-theme user never sees
// a dark frame.
if (typeof window !== 'undefined') applyTheme(loadTheme());
