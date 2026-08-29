/**
 * @license
 * Copyright 2026 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OttoBridge } from '../preload/index.js';

export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface TauriInternals {
  invoke?: TauriInvoke;
}

declare global {
  interface Window {
    /** Tauri runtime global when `app.withGlobalTauri` is enabled. */
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export class TauriBridgeUnsupportedError extends Error {
  readonly code = 'TAURI_BRIDGE_UNSUPPORTED';

  constructor(readonly capability: string) {
    super(`Desktop capability "${capability}" has not migrated to Tauri yet.`);
    this.name = 'TauriBridgeUnsupportedError';
  }
}

export class HostBridgeUnavailableError extends Error {
  readonly code = 'DESKTOP_HOST_BRIDGE_UNAVAILABLE';

  constructor() {
    super('No Electron preload or Tauri desktop bridge is available.');
    this.name = 'HostBridgeUnavailableError';
  }
}

/**
 * First migration slice. Only low-risk, request/response capabilities with a
 * direct Tauri command are exposed here. In particular, tool execution,
 * account/privacy mutations and module lifecycle operations remain unsupported
 * until their confirmation, central-policy and audit paths are implemented.
 */
export function createTauriHostBridge(invoke: TauriInvoke): OttoBridge {
  const migrated: Partial<Record<keyof OttoBridge, (...args: never[]) => unknown>> = {
    openExternal: ((url: string) =>
      invoke<void>('open_external', { url })) as never,
    openPath: ((path: string) =>
      invoke<void>('open_path', { path })) as never,
    selectFiles: (() => invoke<string[]>('select_files')) as never,
    selectFolders: (() => invoke<string[]>('select_folders')) as never,
    themeGet: (() =>
      invoke<'system' | 'light' | 'dark'>('theme_get')) as never,
    themeSet: ((theme: 'system' | 'light' | 'dark') =>
      invoke<'system' | 'light' | 'dark'>('theme_set', { theme })) as never,
    writeClipboard: ((text: string) =>
      invoke<void>('write_clipboard', { text })) as never,
  };

  return new Proxy(migrated, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      const implementation = target[property as keyof OttoBridge];
      if (implementation) return implementation;
      return () => {
        throw new TauriBridgeUnsupportedError(property);
      };
    },
  }) as OttoBridge;
}

/** Resolve the active desktop shell while Electron remains available as fallback. */
export function getHostBridge(): OttoBridge {
  if (window.otto) return window.otto;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (invoke) return createTauriHostBridge(invoke);
  throw new HostBridgeUnavailableError();
}
