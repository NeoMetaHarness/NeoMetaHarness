import { useLayoutEffect, useState, type PropsWithChildren } from 'react';
import { NeoTheme } from '@neometaharness/ui/shell';

export const appearanceModes = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

type ColorMode = 'light' | 'dark';
export type Appearance = 'system' | ColorMode;

const storageKey = 'neo.appearance';

function parseAppearance(value: string | null | undefined): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function useAppearance() {
  const [appearance, setAppearance] = useState(() => parseAppearance(document.documentElement.dataset.neoAppearance));
  const [systemMode, setSystemMode] = useState<ColorMode>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const mode = appearance === 'system' ? systemMode : appearance;

  useLayoutEffect(() => {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const updateMode = () => setSystemMode(scheme.matches ? 'dark' : 'light');
    const syncPreference = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === storageKey || event.key === null)) {
        setAppearance(parseAppearance(event.newValue));
      }
    };
    updateMode();
    scheme.addEventListener('change', updateMode);
    window.addEventListener('storage', syncPreference);
    return () => {
      scheme.removeEventListener('change', updateMode);
      window.removeEventListener('storage', syncPreference);
    };
  }, []);

  function saveAppearance(value: string) {
    const next = parseAppearance(value);
    setAppearance(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch { /* The preference still applies in this window. */ }
  }

  return { appearance, mode, saveAppearance };
}

export function AppAppearance({ mode, children }: PropsWithChildren<{ mode: ColorMode }>) {
  useLayoutEffect(() => {
    const background = getComputedStyle(document.documentElement).getPropertyValue('--neo-color-canvas').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
    const native = (window as Window & {
      __TAURI_INTERNALS__?: {
        invoke(name: 'set_window_appearance', args: { mode: ColorMode; background: [number, number, number] }): Promise<void>;
      };
    }).__TAURI_INTERNALS__;
    if (native && /^#[0-9a-f]{6}$/i.test(background)) {
      const channels = [1, 3, 5].map((offset) => Number.parseInt(background.slice(offset, offset + 2), 16));
      const [red, green, blue] = channels;
      void native.invoke('set_window_appearance', { mode, background: [red, green, blue] }).catch(console.warn);
    }
  }, [mode]);

  return <NeoTheme mode={mode}>{children}</NeoTheme>;
}
