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
  Reflect.deleteProperty(window, 'clawmaster');
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
    const bounds = { x: 640, y: 80, width: 600, height: 680 };
    await expect(bridge.platformWebviewOpen?.('https://clawmaster.example', bounds)).resolves.toEqual({
      command: 'platform_webview_open',
      args: { url: 'https://clawmaster.example', bounds },
    });
    await expect(bridge.platformWebviewSetBounds?.(bounds)).resolves.toEqual({
      command: 'platform_webview_set_bounds',
      args: { bounds },
    });
    await expect(bridge.platformWebviewReload?.()).resolves.toEqual({
      command: 'platform_webview_reload',
      args: undefined,
    });
    await expect(bridge.platformWebviewClose?.()).resolves.toEqual({
      command: 'platform_webview_close',
      args: undefined,
    });
    await expect(bridge.themeSet('dark')).resolves.toEqual({
      command: 'theme_set',
      args: { theme: 'dark' },
    });
    await expect(bridge.selectFiles()).resolves.toEqual({
      command: 'select_files',
      args: undefined,
    });
    await expect(bridge.inspectLocalPath('/Users/test/report.md')).resolves.toEqual({
      command: 'inspect_local_path',
      args: { path: '/Users/test/report.md' },
    });
    await expect(bridge.readFilePath('/Users/test/photo.png')).resolves.toEqual({
      command: 'read_file_path',
      args: { filePath: '/Users/test/photo.png' },
    });
    await expect(bridge.saveTextFile('report.md', '# Report')).resolves.toEqual({
      command: 'save_text_file',
      args: { suggestedFileName: 'report.md', content: '# Report' },
    });
    await expect(bridge.updateCheck()).resolves.toEqual({
      command: 'update_check',
      args: undefined,
    });
    await expect(bridge.updateDownload()).resolves.toEqual({
      command: 'update_download',
      args: undefined,
    });
    await expect(bridge.updateCancel()).resolves.toEqual({
      command: 'update_cancel',
      args: undefined,
    });
    await expect(bridge.updateInstall()).resolves.toEqual({
      command: 'update_install',
      args: undefined,
    });
    await expect(bridge.runtimeDiagnostic()).resolves.toEqual({
      command: 'runtime_diagnostic',
      args: undefined,
    });
    await expect(bridge.nativeChannelConfigGet?.('dingtalk')).resolves.toEqual({
      command: 'channel_config_get', args: { provider: 'dingtalk' },
    });
    await expect(bridge.nativeChannelStatusGet?.('feishu')).resolves.toEqual({
      command: 'channel_status_get', args: { provider: 'feishu' },
    });
    await expect(bridge.nativeChannelConnectionSet?.('feishu', true)).resolves.toEqual({
      command: 'channel_connection_set', args: { provider: 'feishu', connected: true },
    });
    await expect(bridge.nativeChannelConfigSave?.({
      provider: 'wecom', appId: 'corp', appSecret: 'secret', agentId: '1001',
    })).resolves.toEqual({
      command: 'channel_config_save',
      args: { input: { provider: 'wecom', appId: 'corp', appSecret: 'secret', agentId: '1001' } },
    });
    await expect(bridge.nativeChannelSendTest?.({
      provider: 'dingtalk', targetId: 'user-1', text: 'hello',
    })).resolves.toEqual({
      command: 'channel_send_test',
      args: { input: { provider: 'dingtalk', targetId: 'user-1', text: 'hello' } },
    });
    await expect(bridge.notificationShow({
      sessionId: 'session-1',
      source: 'park',
      sender: '园区服务台',
      preview: '您的报修已有新回复',
    })).resolves.toEqual({
      command: 'notification_show',
      args: {
        payload: {
          sessionId: 'session-1',
          source: 'park',
          sender: '园区服务台',
          preview: '您的报修已有新回复',
        },
      },
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
    expect(bridge.onUpdateProgress(vi.fn())).toEqual(expect.any(Function));
    expect(bridge.onMenu(vi.fn())).toEqual(expect.any(Function));
  });

  it('provides honest local snapshots for migrated enterprise settings', async () => {
    const bridge = createTauriHostBridge(vi.fn() as unknown as TauriInvoke);

    await expect(bridge.enterpriseUsageProfile(7)).resolves.toMatchObject({
      accountId: 'tauri-local-user',
      periodDays: 7,
      totalTokens: 0,
      requestCount: 0,
      byModel: [],
      daily: [],
    });
    await expect(bridge.enterpriseDataGovernanceGet()).resolves.toMatchObject({
      controller: { configured: false },
      residency: { mode: 'local_device', crossBorderEnabled: false },
      readiness: { configured: false },
      processingActivities: [],
    });
    await expect(bridge.enterpriseE2eeDevicesList()).resolves.toEqual([]);
    await expect(bridge.enterpriseE2eeKeyTransparency()).resolves.toMatchObject({
      accountId: 'tauri-local-user',
      headSequence: 0,
      entries: [],
    });
  });

  it('backs personal enterprise knowledge and Skill views with Rust runtime data', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command !== 'desktop_request') return undefined;
      const frame = args?.frame as { type: string };
      if (frame.type === 'search_knowledge') {
        return [{
          type: 'knowledge_data',
          payload: { action: 'search', query: 'Rust', entries: [{
            id: 'knowledge-1', category: 'runtime', content: 'Rust 原生知识',
            tags: ['rust'], createdAt: '2026-09-05T00:00:00Z', confidence: 0.9,
          }] },
        }];
      }
      return [{
        type: 'skills_list',
        payload: { skills: [{
          id: 'ppt-creator', name: 'PPT 创作', description: 'Rust 原生 PPTX',
          marketplaceId: 'builtin', pluginId: 'core', enabled: true,
        }] },
      }];
    });
    const bridge = createTauriHostBridge(invoke as unknown as TauriInvoke);

    await expect(bridge.enterpriseKnowledgeList({ query: 'Rust' })).resolves.toEqual([
      expect.objectContaining({ id: 'knowledge-1', content: 'Rust 原生知识', status: 'active' }),
    ]);
    await expect(bridge.enterpriseSkillList()).resolves.toEqual([
      expect.objectContaining({ id: 'ppt-creator', installedVersion: 1, status: 'active' }),
    ]);
    await expect(bridge.enterpriseSkillLocalList()).resolves.toEqual([
      { name: 'PPT 创作', description: 'Rust 原生 PPTX', kind: 'personal' },
    ]);
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
    const openPlatform = vi.fn();
    window.addEventListener('clawmaster:open-platform', openPlatform);
    bridge.onFrame(frames);
    bridge.onConnectionChange(connections);

    await expect(bridge.connect()).resolves.toBe(true);
    eventHandlers.get('desktop://connection-change')?.({ payload: true });
    eventHandlers.get('desktop://server-frame')?.({
      payload: { type: 'sessions', payload: { sessions: [] } },
    });
    eventHandlers.get('desktop://open-platform')?.({
      payload: { id: 'platform-agent-browser', label: 'Example', url: 'https://example.com/' },
    });

    expect(bridge.isConnected()).toBe(true);
    expect(connections).toHaveBeenNthCalledWith(1, false);
    expect(connections).toHaveBeenLastCalledWith(true);
    expect(frames).toHaveBeenCalledWith({
      type: 'sessions', payload: { sessions: [] },
    });
    expect(openPlatform).toHaveBeenCalledOnce();
    expect((openPlatform.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      id: 'platform-agent-browser', label: 'Example', url: 'https://example.com/',
    });
    window.removeEventListener('clawmaster:open-platform', openPlatform);
  });

  it('serves work logs through the shared local Server instead of a Tauri copy', async () => {
    const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
    const listen = vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(event, handler);
      return vi.fn();
    });
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'desktop_connect') return true;
      if (command === 'desktop_send') {
        const frame = args?.frame as { type: string; payload: { requestId: string } };
        const payload = frame.type === 'work_log_today'
          ? {
              type: 'work_log_today_result',
              payload: {
                requestId: frame.payload.requestId,
                summary: {
                  summary: '今天完成 1 项工作。',
                  date: '2026-09-02',
                  totalActions: 1,
                  workResults: 1,
                },
              },
            }
          : {
              type: 'work_log_recent_result',
              payload: { requestId: frame.payload.requestId, days: [] },
            };
        queueMicrotask(() => eventHandlers.get('desktop://server-frame')?.({ payload }));
      }
      return undefined;
    });
    const bridge = createTauriHostBridge(
      invoke as unknown as TauriInvoke,
      listen as never,
    );

    await expect(bridge.workLogToday()).resolves.toMatchObject({
      date: '2026-09-02',
      workResults: 1,
    });
    await expect(bridge.workLogRecent(7)).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('desktop_send', {
      frame: expect.objectContaining({
        type: 'work_log_recent',
        payload: expect.objectContaining({ days: 7 }),
      }),
    });
  });

  it('subscribes to Tauri events before connecting and publishes the resolved state', async () => {
    let releaseListeners!: () => void;
    const listenersReady = new Promise<void>((resolve) => {
      releaseListeners = resolve;
    });
    const listen = vi.fn(async () => {
      await listenersReady;
      return vi.fn();
    });
    const invoke = vi.fn(async () => true);
    const bridge = createTauriHostBridge(
      invoke as unknown as TauriInvoke,
      listen as never,
    );
    const connections = vi.fn();
    bridge.onConnectionChange(connections);

    const connecting = bridge.connect();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();

    releaseListeners();
    await expect(connecting).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('desktop_connect');
    expect(connections).toHaveBeenNthCalledWith(1, false);
    expect(connections).toHaveBeenLastCalledWith(true);
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
    Object.defineProperty(window, 'clawmaster', {
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
    Reflect.deleteProperty(window, 'clawmaster');
    const invoke = vi.fn(async () => 'system');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });

    await expect(getHostBridge().themeGet()).resolves.toBe('system');
    expect(invoke).toHaveBeenCalledWith('theme_get');
  });

  it('installs the Tauri bridge before direct window.clawmaster consumers render', async () => {
    Reflect.deleteProperty(window, 'clawmaster');
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
    await expect(window.clawmaster.themeGet()).resolves.toBe('system');
    expect(installTauriHostBridge()).toBe(false);
  });

  it('does not hide a broken Tauri runtime behind browser preview data', () => {
    Reflect.deleteProperty(window, 'clawmaster');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    expect(() => installTauriHostBridge()).toThrow(HostBridgeUnavailableError);
  });

  it('allows the explicit browser preview when no desktop runtime exists', () => {
    Reflect.deleteProperty(window, 'clawmaster');
    expect(installTauriHostBridge()).toBe(false);
  });

  it('reports a missing desktop host instead of crashing on window.clawmaster', () => {
    Reflect.deleteProperty(window, 'clawmaster');
    expect(() => getHostBridge()).toThrow(HostBridgeUnavailableError);
  });
});
