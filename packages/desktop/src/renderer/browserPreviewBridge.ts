/**
 * Minimal browser-only bridge used by the product UI smoke test.
 *
 * Desktop builds inject the real bridge. This fallback deliberately models only
 * renderer startup and read-only demo data; business workflows belong in the
 * server or native host, not in a second frontend implementation.
 */

type PreviewFrame = { type: string; payload: Record<string, unknown> };
type PreviewWindow = { clawmaster?: unknown };

export {};

const previewWindow = window as unknown as PreviewWindow;

if (!previewWindow.clawmaster) {
  const frameHandlers = new Set<(frame: PreviewFrame) => void>();
  const connectionHandlers = new Set<(connected: boolean) => void>();
  let connected = false;
  let currentModel = 'preview-model';
  let sessions = [makeSession('preview-session', '园区服务本地演示')];

  const account = {
    id: 'browser-dev',
    organizationId: 'preview-park-admin',
    organizationName: '宏创园区管理方',
    accountType: 'enterprise',
    employeeId: null,
    username: 'park.admin',
    phone: '+8613800000000',
    name: '园区管理员',
    role: '园区管理员',
    department: '园区管理部',
    departmentId: 'preview-park-dept',
    positionId: null,
    positionTitle: '园区管理员',
    isAdmin: true,
    status: 'active',
    tags: ['园区管理员'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const parkServices = [
    ['renovation', '装修管理'],
    ['parking', '停车办理'],
    ['network-phone', '网络与固话'],
    ['meeting-room', '会议室预约'],
    ['electric-card', '电卡服务'],
    ['repair', '物业报修'],
    ['vehicle-visit', '车辆与访客'],
    ['announcement', '园区公告'],
    ['satisfaction', '满意度调查'],
  ].map(([id, name]) => ({
    parkId: 'preview-park',
    id,
    name,
    enabled: true,
    config: {},
    updatedAt: new Date().toISOString(),
  }));

  function makeSession(sessionId: string, title: string): Record<string, unknown> {
    return {
      sessionId,
      title,
      model: currentModel,
      status: 'idle',
      messageCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function emit(type: string, payload: Record<string, unknown>): void {
    for (const handler of frameHandlers) handler({ type, payload });
  }

  function emitModels(): void {
    emit('models_list', {
      current: currentModel,
      models: [{
        id: currentModel,
        displayName: 'GPT-5.1',
        provider: 'openai',
        enabled: true,
      }],
    });
  }

  const noopSubscription = (): (() => void) => () => {};
  const emptyList = (): Promise<never[]> => Promise.resolve([]);
  const unsupportedDocument = (): Promise<never> => Promise.reject(
    new Error('浏览器预览不读取本地文件，请在桌面版中打开。'),
  );

  const bridge: Record<string, unknown> = {
    connect: async () => {
      connected = true;
      for (const handler of connectionHandlers) handler(true);
      window.setTimeout(() => {
        emit('sessions_list', { sessions });
        emitModels();
      }, 0);
      return true;
    },
    onFrame: (handler: (frame: PreviewFrame) => void) => {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onConnectionChange: (handler: (state: boolean) => void) => {
      connectionHandlers.add(handler);
      handler(connected);
      return () => connectionHandlers.delete(handler);
    },
    send: (frame: { type?: string; payload?: Record<string, unknown> }) => {
      const payload = frame.payload ?? {};
      if (frame.type === 'list_sessions') emit('sessions_list', { sessions });
      if (frame.type === 'get_models' || frame.type === 'list_models') emitModels();
      if (frame.type === 'get_history') {
        emit('history', { sessionId: payload.sessionId, messages: [] });
      }
      if (frame.type === 'create_session') {
        const session = makeSession(`preview-${Date.now()}`, String(payload.title ?? '新对话'));
        sessions = [session, ...sessions];
        emit('session_created', { session, clientRequestId: payload.clientRequestId });
      }
      if (frame.type === 'set_model') {
        currentModel = String(payload.model ?? currentModel);
        emitModels();
      }
      if (frame.type === 'send_user_message') {
        const sessionId = String(payload.sessionId ?? sessions[0]?.sessionId);
        const messageId = `preview-answer-${Date.now()}`;
        const text = '这是浏览器本地预览；正式任务由桌面运行时执行。';
        emit('message_start', {
          message: {
            id: messageId,
            sessionId,
            role: 'assistant',
            content: [{ type: 'text', value: '' }],
            timestamp: Date.now(),
            source: 'local',
            isStreaming: true,
          },
        });
        window.setTimeout(() => {
          emit('chat_chunk', { sessionId, messageId, delta: text });
          emit('chat_complete', { sessionId, messageId, text, finishReason: 'stop' });
        }, 0);
      }
    },

    appVersion: async () => '0.0.2-beta.3-browser-preview',
    getWorkspaceDirectories: async () => ({
      defaultPath: '/Users/demo',
      recentPaths: ['/Users/demo'],
    }),
    taskRuntimeSetActive: async (active: boolean) => active,
    autoGeneratedAgentProfiles: emptyList,
    communitySkillList: emptyList,
    customerModuleInstalledList: emptyList,
    extractEditableDocument: unsupportedDocument,

    enterpriseSession: async () => ({
      serverUrl: 'browser-preview://local',
      account,
    }),
    enterpriseRegistrationIntent: async () => null,
    enterpriseOrganizationFeaturesGet: async () => ({
      enterprise_tree: true,
      park_service: true,
      feishu_auto_reply: false,
      direct_messages: true,
      atoa: true,
      knowledge: true,
      skill_market: true,
    }),
    enterpriseCompanyOsBrief: async () => ({
      organizationId: account.organizationId,
      generatedAt: '2026-09-06T08:00:00.000Z',
      status: 'partial' as const,
      metrics: {
        revenue: { status: 'known' as const, stale: false, amount: { currency: 'CNY', minorUnits: '126800000' }, evidenceRefs: ['preview-revenue'], sources: [] },
        margin: { status: 'known' as const, stale: false, amount: { currency: 'CNY', minorUnits: '35400000' }, basisPoints: 2792, evidenceRefs: ['preview-margin'], sources: [] },
        inventory: { status: 'partial' as const, stale: false, value: { currency: 'CNY', minorUnits: '48600000' }, daysCover: 42, evidenceRefs: ['preview-inventory'], sources: [] },
        cash: { status: 'known' as const, stale: false, balance: { currency: 'CNY', minorUnits: '82000000' }, netWorkingCapital: { currency: 'CNY', minorUnits: '76300000' }, runwayDays: 96, overdueReceivablesBps: 840, evidenceRefs: ['preview-cash'], sources: [] },
        growth: { status: 'partial' as const, stale: false, revenueGrowthBps: 1230, contributionGrowthBps: null, attribution: 'hypothesis' as const, attributionAssumptions: ['preview only'], evidenceRefs: ['preview-growth'], sources: [] },
      },
      missing: ['growth'], risks: ['增长贡献利润事实不完整'], opportunities: [],
      evidenceRefs: [], invalidEvidenceRefs: [], recommendedActions: [],
      executedActions: [], decisionsRequired: [],
    }),
    enterpriseParkView: async () => ({
      id: 'preview-park',
      name: '北控宏创科技园',
      slug: 'browser-preview',
      brandName: '北控宏创园区服务',
      adminOrganizationId: account.organizationId,
      status: 'active',
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      isAdminOrganization: true,
      services: parkServices,
      tenantAddress: '科技大厦 A 座',
      tenantRoomNumber: '1203 室',
    }),
    enterprisePresenceHeartbeat: async () => undefined,
    enterpriseMessagesUnread: emptyList,
    enterpriseFederationContacts: emptyList,
    enterpriseFederationAtoaTasks: emptyList,
    enterpriseAtoaInbox: emptyList,
    enterpriseTicketList: emptyList,
    enterpriseParkPublications: emptyList,

    notificationGetUnread: emptyList,
    notificationShow: async () => undefined,
    parkNativeNotify: async () => true,
    platformWebviewOpen: async () => undefined,
    platformWebviewSetBounds: async () => undefined,
    platformWebviewClose: async () => undefined,

    onMenu: noopSubscription,
    onUpdateProgress: noopSubscription,
    onNotificationUnreadChanged: noopSubscription,
    onNotificationSessionOpen: noopSubscription,
    onEnterpriseRegistrationIntent: noopSubscription,
    onEnterpriseSessionInvalidated: noopSubscription,
    onEnterpriseAccountUpdated: noopSubscription,
  };

  previewWindow.clawmaster = new Proxy(bridge, {
    get(target, key) {
      return key in target
        ? target[key as string]
        : () => Promise.resolve(null);
    },
  });
}
