/**
 * @license
 * Copyright 2026 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostBridgeUnavailableError,
  TauriBridgeUnsupportedError,
  createTauriHostBridge,
  getHostBridge,
  type TauriInvoke,
} from './hostBridge.js';

afterEach(() => {
  Reflect.deleteProperty(window, 'otto');
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('Tauri host bridge', () => {
  it('maps supported low-risk methods to typed Tauri commands', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const bridge = createTauriHostBridge(invoke as unknown as TauriInvoke);

    await expect(bridge.openExternal('https://clawmaster.example')).resolves.toEqual({
      command: 'open_external',
      args: { url: 'https://clawmaster.example' },
    });
    await expect(bridge.themeSet('dark')).resolves.toEqual({
      command: 'theme_set',
      args: { theme: 'dark' },
    });
    await expect(bridge.selectFiles()).resolves.toEqual({
      command: 'select_files',
      args: undefined,
    });
  });

  it('fails explicitly for capabilities that have not migrated', async () => {
    const bridge = createTauriHostBridge(vi.fn() as unknown as TauriInvoke);

    expect(() => bridge.send({ type: 'list_sessions', payload: {} })).toThrow(
      TauriBridgeUnsupportedError,
    );
    expect(() =>
      bridge.enterprisePrivacyDelete({ password: 'not-a-secret', confirmation: 'DELETE' }),
    ).toThrowError(
      expect.objectContaining({
        code: 'TAURI_BRIDGE_UNSUPPORTED',
        capability: 'enterprisePrivacyDelete',
      }),
    );
  });

  it('keeps the Electron preload bridge as the compatibility path', () => {
    const electronBridge = { connect: vi.fn() };
    Object.defineProperty(window, 'otto', {
      configurable: true,
      value: electronBridge,
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: vi.fn() },
    });

    expect(getHostBridge()).toBe(electronBridge);
  });

  it('discovers Tauri invoke without requiring the Electron preload', async () => {
    Reflect.deleteProperty(window, 'otto');
    const invoke = vi.fn(async () => 'system');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });

    await expect(getHostBridge().themeGet()).resolves.toBe('system');
    expect(invoke).toHaveBeenCalledWith('theme_get');
  });

  it('reports a missing desktop host instead of crashing on window.otto', () => {
    Reflect.deleteProperty(window, 'otto');
    expect(() => getHostBridge()).toThrow(HostBridgeUnavailableError);
  });
});
