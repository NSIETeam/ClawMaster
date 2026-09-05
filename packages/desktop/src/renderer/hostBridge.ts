/**
 * @license
 * Copyright 2026 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopRuntimeDiagnostic,
  ClawMasterBridge,
  EnterpriseKnowledgeItem,
  EnterpriseSkillLeaderboard,
  EnterpriseSkillMarketItem,
  LocalSkillShareCandidate,
  NativeChannelConfig,
  NativeChannelStatus,
  NativeChannelProvider,
  PlatformWebviewBounds,
  UpdateProgressInfo,
} from '../preload/index.js';
import type { ClientToServer, ServerToClient } from 'clawmaster-server';

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
): ClawMasterBridge {
  let connected = false;
  let requestSequence = 0;
  const frameHandlers = new Set<(frame: ServerToClient) => void>();
  const connectionHandlers = new Set<(value: boolean) => void>();
  const updateProgressHandlers = new Set<(value: UpdateProgressInfo) => void>();
  const pendingRequests = new Map<string, {
    expectedType: ServerToClient['type'];
    resolve: (frame: ServerToClient) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const dispatchFrame = (frame: ServerToClient): void => {
    const requestId = 'payload' in frame
      && frame.payload
      && 'requestId' in frame.payload
      && typeof frame.payload.requestId === 'string'
      ? frame.payload.requestId
      : undefined;
    const pending = requestId ? pendingRequests.get(requestId) : undefined;
    if (requestId && pending && (frame.type === pending.expectedType || frame.type === 'error')) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      if (frame.type === 'error') pending.reject(new Error(frame.payload.message));
      else pending.resolve(frame);
    }
    for (const handler of frameHandlers) handler(frame);
  };
  const dispatchConnection = (value: boolean): void => {
    connected = value;
    if (!value && pendingRequests.size > 0) {
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('ClawMaster 本地 Server 连接已断开。'));
      }
      pendingRequests.clear();
    }
    for (const handler of connectionHandlers) handler(value);
  };
  const noopSubscription = (): (() => void) => () => undefined;
  const localAccountTimestamp = new Date(0).toISOString();
  const listenersReady = listen
    ? Promise.all([
        listen<ServerToClient>('desktop://server-frame', ({ payload }) =>
          dispatchFrame(payload),
        ),
        listen<boolean>('desktop://connection-change', ({ payload }) =>
          dispatchConnection(payload),
        ),
        listen<UpdateProgressInfo>('desktop://update-progress', ({ payload }) => {
          for (const handler of updateProgressHandlers) handler(payload);
        }),
        listen<{ id: string; label: string; url: string }>(
          'desktop://open-platform',
          ({ payload }) => window.dispatchEvent(new CustomEvent(
            'clawmaster:open-platform',
            { detail: payload },
          )),
        ),
      ]).then(() => undefined)
    : Promise.resolve();

  const connectDesktop = async (): Promise<boolean> => {
    if (!listen) throw new TauriBridgeUnsupportedError('onFrame');
    await listenersReady;
    const nextConnected = await invoke<boolean>('desktop_connect');
    if (connected !== nextConnected) dispatchConnection(nextConnected);
    return nextConnected;
  };

  const requestServerFrame = async (
    frame: ClientToServer,
    expectedType: ServerToClient['type'],
  ): Promise<ServerToClient> => {
    if (!connected && !await connectDesktop()) {
      throw new Error('ClawMaster 本地 Server 尚未就绪。');
    }
    const requestId = 'requestId' in frame.payload
      ? String(frame.payload.requestId)
      : '';
    if (!requestId) throw new Error('本地 Server 请求缺少 requestId。');
    return new Promise<ServerToClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('ClawMaster 本地 Server 请求超时。'));
      }, 10_000);
      pendingRequests.set(requestId, { expectedType, resolve, reject, timer });
      void invoke<void>('desktop_send', { frame }).catch((error: unknown) => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  const nextRequestId = (): string =>
    `work-log-${Date.now().toString(36)}-${++requestSequence}`;

  const requestNativeFrame = async (
    frame: ClientToServer,
    expectedType: ServerToClient['type'],
  ): Promise<ServerToClient> => {
    const responses = await invoke<ServerToClient[]>('desktop_request', { frame });
    const error = responses.find((response) => response.type === 'error');
    if (error?.type === 'error') throw new Error(error.payload.message);
    const response = responses.find((candidate) => candidate.type === expectedType);
    if (!response) throw new Error(`Rust 运行时没有返回 ${expectedType}`);
    return response;
  };

  const localSkillMarket = async (): Promise<EnterpriseSkillMarketItem[]> => {
    const response = await requestNativeFrame(
      { type: 'get_skills', payload: {} },
      'skills_list',
    );
    if (response.type !== 'skills_list') return [];
    const timestamp = new Date(0).toISOString();
    return response.payload.skills.filter((skill) => skill.enabled).map((skill) => ({
      id: skill.id,
      organizationId: 'tauri-local',
      slug: skill.id,
      name: skill.name,
      description: skill.description,
      department: null,
      visibility: 'company',
      status: 'active',
      authorAccountId: 'tauri-local-user',
      authorName: '本机 Skill',
      contentHash: skill.id,
      version: 1,
      installCount: 1,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      rating: 0,
      ratingCount: 0,
      installedVersion: 1,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  };

  const migrated: Partial<Record<keyof ClawMasterBridge, (...args: never[]) => unknown>> = {
    nativeChannelConfigGet: ((provider: NativeChannelProvider) =>
      invoke<NativeChannelConfig | null>('channel_config_get', { provider })) as never,
    nativeChannelStatusGet: ((provider: NativeChannelProvider) =>
      invoke<NativeChannelStatus>('channel_status_get', { provider })) as never,
    nativeChannelConfigSave: ((input: {
      provider: NativeChannelProvider; appId: string; appSecret: string; agentId?: string;
      connectionMode?: 'bot' | 'agent';
    }) => invoke<NativeChannelConfig>('channel_config_save', { input })) as never,
    nativeChannelConfigClear: ((provider: NativeChannelProvider) =>
      invoke<void>('channel_config_clear', { provider })) as never,
    nativeChannelSendTest: ((input: {
      provider: NativeChannelProvider; targetId: string; text: string;
    }) => invoke('channel_send_test', { input })) as never,
    connect: connectDesktop as never,
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
    platformWebviewOpen: ((url: string, bounds: PlatformWebviewBounds) =>
      invoke<void>('platform_webview_open', { url, bounds })) as never,
    platformWebviewSetBounds: ((bounds: PlatformWebviewBounds) =>
      invoke<void>('platform_webview_set_bounds', { bounds })) as never,
    platformWebviewReload: (() =>
      invoke<void>('platform_webview_reload')) as never,
    platformWebviewClose: (() =>
      invoke<void>('platform_webview_close')) as never,
    openPath: ((path: string) =>
      invoke<void>('open_path', { path })) as never,
    inspectLocalPath: ((path: string) =>
      invoke<{ exists: boolean; kind: 'file' | 'directory' | 'missing'; canOpen: boolean }>(
        'inspect_local_path', { path },
      )) as never,
    activateLocalPath: ((path: string, action: 'open' | 'reveal') =>
      invoke<{ ok: boolean; error?: string }>('activate_local_path', { path, action })) as never,
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
    getPathForFile: (() => '') as never,
    authorizeFileForAttachment: (() => Promise.reject(
      new Error('Tauri 拖拽附件无法取得可信路径，请使用“添加附件”原生选择器。'),
    )) as never,
    readFilePath: ((filePath: string) => invoke<{
      filePath: string;
      fileName: string;
      size: number;
      mimeType: string;
      data: string;
    }>('read_file_path', { filePath })) as never,
    extractEditableDocument: ((filePath: string) => invoke(
      'extract_editable_document', { filePath },
    )) as never,
    exportEditedDocument: ((sourcePath: string, suggestedFileName: string, content: string) => invoke(
      'export_edited_document', { sourcePath, suggestedFileName, content },
    )) as never,
    saveTextFile: ((suggestedFileName: string, content: string) =>
      invoke<string | null>('save_text_file', { suggestedFileName, content })) as never,
    appVersion: (() => invoke<string>('app_version')) as never,
    updateCheck: (() => invoke('update_check')) as never,
    updateDownload: (() => invoke('update_download')) as never,
    updateCancel: (() => invoke<void>('update_cancel')) as never,
    updateInstall: (() => invoke('update_install')) as never,
    runtimeDiagnostic: (() =>
      invoke<DesktopRuntimeDiagnostic>('runtime_diagnostic')) as never,
    notificationShow: ((payload: Parameters<ClawMasterBridge['notificationShow']>[0]) =>
      invoke<void>('notification_show', { payload })) as never,
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
    enterpriseUsageProfile: ((periodDays = 30) => Promise.resolve({
      accountId: 'tauri-local-user',
      periodDays,
      source: 'client_reported',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      averageTokensPerRequest: 0,
      lastUsedAt: null,
      byModel: [],
      daily: [],
    })) as never,
    enterpriseDataGovernanceGet: (() => Promise.resolve({
      controller: {
        name: 'ClawMaster Local',
        privacyContact: '未配置',
        configured: false,
      },
      residency: {
        mode: 'local_device',
        region: '本机',
        crossBorderEnabled: false,
        localizationReady: true,
      },
      security: {
        publicTransport: '本地应用内通信',
        database: '本机存储',
        encryptedData: [],
        hashedData: [],
        plaintextData: [],
      },
      retention: {
        securityAuditMinimumDays: 0,
        encryptedBackupDefaultDays: 0,
        healthTelemetryDefaultDays: 0,
      },
      readiness: {
        configured: false,
        warnings: ['当前为本地个人模式，尚未连接企业数据治理服务。'],
      },
      documents: [],
      processingActivities: [],
      rights: [],
      currentConsentComplete: true,
      authorization: {
        deploymentId: 'tauri-local',
        license: {
          status: 'local',
          plan: 'local',
          expiresAt: '',
          seatLimit: 1,
          activeSeatCount: 1,
          modules: [],
          offline: true,
          enforce: false,
        },
        telemetry: { enabled: false, contentMode: 'disabled' },
        dataBoundary: { mode: 'local_device' },
      },
    })) as never,
    enterpriseE2eeDevicesList: (() => Promise.resolve([])) as never,
    enterpriseE2eeKeyTransparency: (() => Promise.resolve({
      accountId: 'tauri-local-user',
      headSequence: 0,
      headHash: '',
      entries: [],
    })) as never,
    enterpriseKnowledgeList: (async (input?: { query?: string; department?: string }) => {
      const query = input?.query?.trim();
      const response = await requestNativeFrame(
        query
          ? { type: 'search_knowledge', payload: { query, ...(input?.department ? { category: input.department } : {}) } }
          : { type: 'get_knowledge', payload: { limit: 100 } },
        'knowledge_data',
      );
      if (response.type !== 'knowledge_data') return [];
      return response.payload.entries.map((entry): EnterpriseKnowledgeItem => ({
        id: entry.id,
        organizationId: 'tauri-local',
        sourceId: null,
        title: entry.category,
        department: null,
        category: entry.category,
        content: entry.content,
        contributor: '本机知识库',
        confidence: entry.confidence ?? 1,
        sourceType: 'manual',
        sourceLabel: 'ClawMaster Rust 本地知识库',
        status: 'active',
        version: 1,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
      }));
    }) as never,
    enterpriseSkillLocalList: (async (): Promise<LocalSkillShareCandidate[]> => (
      (await localSkillMarket()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        kind: 'personal',
      }))
    )) as never,
    enterpriseSkillList: (async (): Promise<EnterpriseSkillMarketItem[]> => localSkillMarket()) as never,
    enterpriseSkillLeaderboard: (async (): Promise<EnterpriseSkillLeaderboard> => {
      const skills = await localSkillMarket();
      return {
        skills: skills.map((skill, index) => ({
          ...skill,
          rank: index + 1,
          score: 0,
          successRate: 0,
        })),
        contributors: [],
        generatedAt: new Date().toISOString(),
      };
    }) as never,
    feishuStatus: (() => Promise.resolve({
      text: '当前 Rust 本地版尚未配置企业消息连接器。请使用高级配置，或等待管理员部署连接服务。',
      running: false,
    })) as never,
    feishuGetConfig: (() => Promise.resolve({ ok: true, config: null, error: null })) as never,
    feishuSaveConfig: (() => Promise.resolve({
      ok: false,
      config: null,
      error: '当前 Rust 本地版尚未启用飞书凭证服务，未保存任何凭证。',
    })) as never,
    feishuClearConfig: (() => Promise.resolve({ ok: true, config: null, error: null })) as never,
    feishuStart: (() => Promise.resolve({ text: '当前 Rust 本地版尚未配置飞书连接器。' })) as never,
    feishuStop: (() => Promise.resolve({ text: '当前没有运行中的飞书连接器。' })) as never,
    channelPairingBegin: (() => Promise.resolve({
      ok: false,
      pairing: null,
      error: 'channel_connector_unavailable: 当前 Rust 本地版尚未部署扫码连接服务',
    })) as never,
    channelPairingStatus: (() => Promise.resolve({
      ok: false,
      data: null,
      error: '当前没有进行中的扫码连接。',
    })) as never,
    channelPairingInstall: (() => Promise.resolve({
      ok: false,
      data: null,
      error: '当前没有可安装的消息连接。',
    })) as never,
    channelPairingCancel: (() => Promise.resolve({
      ok: false,
      data: null,
      error: '当前没有进行中的扫码连接。',
    })) as never,
    channelInstallations: (() => Promise.resolve({
      ok: true,
      data: [],
      error: null,
    })) as never,
    channelInstallationAction: (() => Promise.resolve({
      ok: false,
      data: null,
      error: '当前 Rust 本地版尚未配置企业消息连接器。',
    })) as never,
    onEnterpriseRegistrationIntent: noopSubscription as never,
    onEnterpriseSessionInvalidated: noopSubscription as never,
    onEnterpriseAccountUpdated: noopSubscription as never,
    onNotificationSessionOpen: noopSubscription as never,
    onNotificationUnreadChanged: noopSubscription as never,
    // Subscription APIs must stay synchronous even while the capability is
    // unavailable in Tauri. Returning the Proxy's rejected Promise here makes
    // React treat that Promise as an effect cleanup function and crashes the UI.
    onUpdateProgress: (((handler: (value: UpdateProgressInfo) => void) => {
      updateProgressHandlers.add(handler);
      return () => updateProgressHandlers.delete(handler);
    })) as never,
    onMenu: noopSubscription as never,
    customerModuleInstalledList: (() => Promise.resolve([])) as never,
    communitySkillInstall: ((input: { id: string; source: string; slug: string }) =>
      invoke<{ id: string; name: string; source: string; installPath: string }>(
        'community_skill_install',
        input,
      )) as never,
    communitySkillList: (() => invoke<Array<{ name: string; installPath: string }>>(
      'community_skill_list',
    )) as never,
    taskRuntimeSetActive: ((active: boolean) => invoke<boolean>(
      'task_runtime_set_active',
      { active },
    )) as never,
    workLogToday: (async () => {
      const requestId = nextRequestId();
      const response = await requestServerFrame(
        { type: 'work_log_today', payload: { requestId } },
        'work_log_today_result',
      );
      if (response.type !== 'work_log_today_result') throw new Error('工作日志响应类型错误。');
      return response.payload.summary;
    }) as never,
    workLogRecent: (async (days?: number) => {
      const requestId = nextRequestId();
      const response = await requestServerFrame(
        { type: 'work_log_recent', payload: { requestId, days } },
        'work_log_recent_result',
      );
      if (response.type !== 'work_log_recent_result') throw new Error('工作日志响应类型错误。');
      return response.payload.days;
    }) as never,
    workLogReport: (async () => {
      const requestId = nextRequestId();
      const response = await requestServerFrame(
        { type: 'work_log_report', payload: { requestId } },
        'work_log_report_result',
      );
      if (response.type !== 'work_log_report_result') throw new Error('工作日志响应类型错误。');
      return response.payload.report;
    }) as never,
    autoGeneratedAgentProfiles: (() => Promise.resolve([])) as never,
    enterpriseMessagesUnread: (() => Promise.resolve([])) as never,
    enterpriseFederationContacts: (() => Promise.resolve([])) as never,
    enterprisePresenceHeartbeat: (() => Promise.resolve()) as never,
  };

  return new Proxy(migrated, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      const implementation = target[property as keyof ClawMasterBridge];
      if (implementation) return implementation;
      return () => Promise.reject(new TauriBridgeUnsupportedError(property));
    },
  }) as ClawMasterBridge;
}

/** Resolve the active desktop shell while Electron remains available as fallback. */
export function getHostBridge(): ClawMasterBridge {
  if (window.clawmaster) return window.clawmaster;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (invoke) return createTauriHostBridge(invoke);
  throw new HostBridgeUnavailableError();
}

/** Install the Tauri bridge before React modules evaluate direct window.clawmaster consumers. */
export function installTauriHostBridge(): boolean {
  if (window.clawmaster) return false;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      throw new HostBridgeUnavailableError();
    }
    return false;
  }
  Object.defineProperty(window, 'clawmaster', {
    configurable: true,
    value: createTauriHostBridge(invoke),
  });
  return true;
}
