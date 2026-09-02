/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceRendererTheme, applyRendererTheme, startRendererThemeSync } from './themeSync.js';

function media(matches: boolean): MediaQueryList {
  const listeners = new Set<EventListener>();
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
      listeners.add(listener as EventListener),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
      listeners.delete(listener as EventListener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: (event: Event) => {
      listeners.forEach((listener) => listener(event));
      return true;
    },
  };
}

afterEach(() => {
  delete document.documentElement.dataset.ottoTheme;
  delete document.documentElement.dataset.ottoThemeSource;
});

describe('renderer theme synchronization', () => {
  it('resolves system appearance onto the document root', () => {
    applyRendererTheme('system', document.documentElement, media(true));
    expect(document.documentElement.dataset.ottoTheme).toBe('dark');
    expect(document.documentElement.dataset.ottoThemeSource).toBe('system');
  });

  it('updates immediately when settings announce a theme', () => {
    const query = media(false);
    const stop = startRendererThemeSync(document.documentElement, query);
    announceRendererTheme('dark', query);
    expect(document.documentElement.dataset.ottoTheme).toBe('dark');
    stop();
  });

  it('follows OS changes only while the source is system', () => {
    const query = media(false);
    const stop = startRendererThemeSync(document.documentElement, query);
    Object.defineProperty(query, 'matches', { value: true, configurable: true });
    query.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.ottoTheme).toBe('dark');
    announceRendererTheme('light', query);
    Object.defineProperty(query, 'matches', { value: false, configurable: true });
    query.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.ottoTheme).toBe('light');
    stop();
  });

  it('does not let a stale startup read overwrite a user selection', async () => {
    let resolveTheme!: (value: 'light') => void;
    const themeGet = new Promise<'light'>((resolve) => { resolveTheme = resolve; });
    Object.defineProperty(window, 'otto', {
      value: { themeGet: () => themeGet },
      configurable: true,
    });
    const query = media(false);
    const stop = startRendererThemeSync(document.documentElement, query);
    announceRendererTheme('dark', query);
    resolveTheme('light');
    await themeGet;
    await Promise.resolve();
    expect(document.documentElement.dataset.ottoTheme).toBe('dark');
    stop();
    Object.defineProperty(window, 'otto', { value: undefined, configurable: true });
  });
});
