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
  installTauriHostBridge,
  type TauriInvoke,
} from './hostBridge.js';

afterEach(() => {
  Reflect.deleteProperty(window, 'otto');
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
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

    await expect(bridge.connect()).rejects.toBeInstanceOf(
      TauriBridgeUnsupportedError,
    );
    await expect(
      bridge.enterprisePrivacyDelete({ password: 'not-a-secret', confirmation: 'DELETE' }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'TAURI_BRIDGE_UNSUPPORTED',
        capability: 'enterprisePrivacyDelete',
      }),
    );
  });

  it('provides a local personal shell without Electron enterprise state', async () => {
    const bridge = createTauriHostBridge(vi.fn(async (command: string) => {
      if (command === 'get_workspace_directories') {
        return { defaultPath: '/Users/test', recentPaths: [] };
      }
      return undefined;
    }) as unknown as TauriInvoke);

    await expect(bridge.enterpriseSession()).resolves.toMatchObject({
      serverUrl: 'tauri://local',
      account: { accountType: 'personal', name: 'ClawMaster User' },
    });
    await expect(bridge.customerModuleInstalledList()).resolves.toEqual([]);
    await expect(bridge.getWorkspaceDirectories()).resolves.toEqual({
      defaultPath: '/Users/test', recentPaths: [],
    });
    expect(bridge.onEnterpriseSessionInvalidated(vi.fn())).toEqual(expect.any(Function));
    expect(bridge.onMenu(vi.fn())).toEqual(expect.any(Function));
  });

  it('bridges connection state and server frames through Tauri events', async () => {
    const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
    const listen = vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(event, handler);
      return vi.fn();
    });
    const invoke = vi.fn(async (command: string) => command === 'desktop_connect');
    const bridge = createTauriHostBridge(
      invoke as unknown as TauriInvoke,
      listen as never,
    );
    const frames = vi.fn();
    const connections = vi.fn();
    bridge.onFrame(frames);
    bridge.onConnectionChange(connections);

    await expect(bridge.connect()).resolves.toBe(true);
    eventHandlers.get('desktop://connection-change')?.({ payload: true });
    eventHandlers.get('desktop://server-frame')?.({
      payload: { type: 'sessions', payload: { sessions: [] } },
    });

    expect(bridge.isConnected()).toBe(true);
    expect(connections).toHaveBeenNthCalledWith(1, false);
    expect(connections).toHaveBeenLastCalledWith(true);
    expect(frames).toHaveBeenCalledWith({
      type: 'sessions', payload: { sessions: [] },
    });
  });

  it('turns a failed asynchronous send into a visible transport error frame', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'desktop_send') throw new Error('socket closed');
      return true;
    });
    const listen = vi.fn(async () => vi.fn());
    const bridge = createTauriHostBridge(invoke as unknown as TauriInvoke, listen as never);
    const frames = vi.fn();
    bridge.onFrame(frames);

    bridge.send({ type: 'list_sessions', payload: {} });
    await vi.waitFor(() => expect(frames).toHaveBeenCalled());
    expect(frames.mock.calls[0]?.[0]).toMatchObject({
      type: 'error', payload: { code: 'desktop_transport_error' },
    });
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

  it('installs the Tauri bridge before direct window.otto consumers render', async () => {
    Reflect.deleteProperty(window, 'otto');
    const invoke = vi.fn(async () => 'system');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { event: { listen: vi.fn(async () => vi.fn()) } },
    });

    expect(installTauriHostBridge()).toBe(true);
    await expect(window.otto.themeGet()).resolves.toBe('system');
    expect(installTauriHostBridge()).toBe(false);
  });

  it('reports a missing desktop host instead of crashing on window.otto', () => {
    Reflect.deleteProperty(window, 'otto');
    expect(() => getHostBridge()).toThrow(HostBridgeUnavailableError);
  });
});
