/**
 * @license
 * Copyright 2026 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OttoBridge } from '../preload/index.js';
import type { ClientToServer, ServerToClient } from 'otto-server';

export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface TauriInternals {
  invoke?: TauriInvoke;
}

type TauriUnlisten = () => void;
type TauriListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<TauriUnlisten>;

declare global {
  interface Window {
    /** Tauri runtime global when `app.withGlobalTauri` is enabled. */
    __TAURI_INTERNALS__?: TauriInternals;
    __TAURI__?: { event?: { listen?: TauriListen } };
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
export function createTauriHostBridge(
  invoke: TauriInvoke,
  listen: TauriListen | undefined = window.__TAURI__?.event?.listen,
): OttoBridge {
  let connected = false;
  const frameHandlers = new Set<(frame: ServerToClient) => void>();
  const connectionHandlers = new Set<(value: boolean) => void>();

  const dispatchFrame = (frame: ServerToClient): void => {
    for (const handler of frameHandlers) handler(frame);
  };
  const dispatchConnection = (value: boolean): void => {
    connected = value;
    for (const handler of connectionHandlers) handler(value);
  };
  const noopSubscription = (): (() => void) => () => undefined;
  const localAccountTimestamp = new Date(0).toISOString();
  if (listen) {
    void listen<ServerToClient>('desktop://server-frame', ({ payload }) =>
      dispatchFrame(payload),
    );
    void listen<boolean>('desktop://connection-change', ({ payload }) =>
      dispatchConnection(payload),
    );
  }

  const migrated: Partial<Record<keyof OttoBridge, (...args: never[]) => unknown>> = {
    connect: (async () => {
      if (!listen) throw new TauriBridgeUnsupportedError('onFrame');
      connected = await invoke<boolean>('desktop_connect');
      return connected;
    }) as never,
    disconnect: (() => {
      connected = false;
      void invoke<void>('desktop_disconnect').catch(() => undefined);
      dispatchConnection(false);
    }) as never,
    send: ((frame: ClientToServer) => {
      void invoke<void>('desktop_send', { frame }).catch((error: unknown) => {
        const sessionId = 'payload' in frame && frame.payload &&
          'sessionId' in frame.payload ? String(frame.payload.sessionId) : '';
        dispatchFrame({
          type: 'error',
          payload: {
            sessionId,
            code: 'desktop_transport_error',
            message: error instanceof Error ? error.message : String(error),
          },
        } as ServerToClient);
      });
    }) as never,
    onFrame: (((handler: (frame: ServerToClient) => void) => {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    })) as never,
    onConnectionChange: (((handler: (value: boolean) => void) => {
      connectionHandlers.add(handler);
      handler(connected);
      return () => connectionHandlers.delete(handler);
    })) as never,
    isConnected: (() => connected) as never,
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
    getWorkspaceDirectories: (() => invoke<{
      defaultPath: string;
      recentPaths: string[];
    }>('get_workspace_directories')) as never,
    selectWorkspaceDirectory: (async () => {
      const selected = await invoke<string[]>('select_folders');
      return selected[0] ?? null;
    }) as never,
    enterpriseSession: (() => Promise.resolve({
      serverUrl: 'tauri://local',
      account: {
        id: 'tauri-local-user',
        organizationId: 'tauri-local',
        organizationName: 'ClawMaster Local',
        accountType: 'personal',
        employeeId: null,
        username: 'local',
        phone: null,
        name: 'ClawMaster User',
        role: null,
        department: null,
        positionId: null,
        positionTitle: null,
        isAdmin: false,
        status: 'active',
        tags: [],
        createdAt: localAccountTimestamp,
        updatedAt: localAccountTimestamp,
      },
    })) as never,
    enterpriseRegistrationIntent: (() => Promise.resolve(null)) as never,
    onEnterpriseRegistrationIntent: noopSubscription as never,
    onEnterpriseSessionInvalidated: noopSubscription as never,
    onEnterpriseAccountUpdated: noopSubscription as never,
    onNotificationSessionOpen: noopSubscription as never,
    onNotificationUnreadChanged: noopSubscription as never,
    onMenu: noopSubscription as never,
    customerModuleInstalledList: (() => Promise.resolve([])) as never,
    autoGeneratedAgentProfiles: (() => Promise.resolve([])) as never,
    enterpriseMessagesUnread: (() => Promise.resolve([])) as never,
    enterpriseFederationContacts: (() => Promise.resolve([])) as never,
    enterprisePresenceHeartbeat: (() => Promise.resolve()) as never,
  };

  return new Proxy(migrated, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      const implementation = target[property as keyof OttoBridge];
      if (implementation) return implementation;
      return () => Promise.reject(new TauriBridgeUnsupportedError(property));
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

/** Install the Tauri bridge before React modules evaluate direct window.otto consumers. */
export function installTauriHostBridge(): boolean {
  if (window.otto) return false;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return false;
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: createTauriHostBridge(invoke),
  });
  return true;
}
