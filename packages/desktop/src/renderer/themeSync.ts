/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

export type ThemeSource = 'system' | 'light' | 'dark';
type ResolvedTheme = Exclude<ThemeSource, 'system'>;

const DARK_QUERY = '(prefers-color-scheme: dark)';

function darkMediaQuery(): MediaQueryList {
  if (typeof window.matchMedia === 'function') return window.matchMedia(DARK_QUERY);
  return {
    matches: false,
    media: DARK_QUERY,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

function resolveTheme(source: ThemeSource, media: MediaQueryList): ResolvedTheme {
  return source === 'system' ? (media.matches ? 'dark' : 'light') : source;
}

export function applyRendererTheme(
  source: ThemeSource,
  root: HTMLElement = document.documentElement,
  media: MediaQueryList = darkMediaQuery(),
): void {
  root.dataset.clawTheme = resolveTheme(source, media);
  root.dataset.clawThemeSource = source;
}

export function startRendererThemeSync(
  root: HTMLElement = document.documentElement,
  media: MediaQueryList = darkMediaQuery(),
): () => void {
  let source: ThemeSource = 'system';
  let sourceWasAnnounced = false;
  const refresh = (): void => applyRendererTheme(source, root, media);
  const onSystemThemeChange = (): void => {
    if (source === 'system') refresh();
  };
  const onThemeSource = (event: Event): void => {
    const value = (event as CustomEvent<ThemeSource>).detail;
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    sourceWasAnnounced = true;
    source = value;
    refresh();
  };

  media.addEventListener('change', onSystemThemeChange);
  window.addEventListener('clawmaster:theme-source', onThemeSource);
  refresh();
  void window.clawmaster?.themeGet?.().then((value) => {
    if (sourceWasAnnounced) return;
    if (value === 'system' || value === 'light' || value === 'dark') {
      source = value;
      refresh();
    }
  });

  return () => {
    media.removeEventListener('change', onSystemThemeChange);
    window.removeEventListener('clawmaster:theme-source', onThemeSource);
  };
}

export function announceRendererTheme(
  source: ThemeSource,
  media: MediaQueryList = darkMediaQuery(),
): void {
  applyRendererTheme(source, document.documentElement, media);
  window.dispatchEvent(new CustomEvent<ThemeSource>('clawmaster:theme-source', { detail: source }));
}
