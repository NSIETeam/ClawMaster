import { useEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import { BrandMark, BrandName, HeroMark, Workbench, WorkbenchIcon } from './Workbench.tsx';
import { connectionLabel, enterpriseTabTypes, observeBetterSidebar, recentSessions, type FrontendServices, type Observable, type WorkbenchRuntimeProps } from './services.ts';
import { productCopy, type ProductLocale } from './locales/frontend.ts';
import { createProductActions, ProductNavigationError } from './navigation.ts';
import { createInitialEntry, type InitialEntryProps } from './initial-entry.ts';
import { CRM, ERP } from './BusinessModules.tsx';
import { acknowledgeOnboarding, decodeOnboarding, ONBOARDING_NAMESPACE, ONBOARDING_VERSION } from './onboarding.ts';
import { WatchdogTutorial, WatchdogTutorialDialog } from './WatchdogTutorial.tsx';
import { onboardingCopy } from './locales/onboarding.ts';
import type { MainPanelId, SessionId, SessionRequestId } from './services.ts';
import styles from './styles.css';
import taskStyles from './task-board.css';
import { TaskBoard } from './TaskBoard.tsx';
import { WatchdogTaskClient } from './watchdog-task-client.ts';
import { RuntimeHealthClient } from './runtime-health-client.ts';
import { RenderBoundary } from './RenderBoundary.tsx';
import { WatchdogScheduleClient } from './watchdog-schedule-client.ts';
import { ScheduleBoard } from './ScheduleBoard.tsx';
import { taskAttentionSummary, type TaskRecord } from './watchdog-task-format.ts';
import { prepareTaskExecution, retryTaskExecution, type PreparedTaskExecution } from './task-execution.ts';
import { observeModelResponses } from './home-model-evidence.ts';

export const name = 'clawmaster-frontend';
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'connection', 'uiWorkspace', 'layout', 'locale', 'settingsScope'];
const PLUGIN_ID = '@clawmaster/dsh-frontend';
type SessionBinding = NonNullable<ReturnType<FrontendServices['sessions']['binding']>>;

function useSnapshot<T>(source: Observable<T>): T {
  return useSyncExternalStore(
    listener => source.subscribe(listener),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  );
}

/** Register product panels on the DSH shell and use its authenticated Host routes. */
export function apply(ctx: FrontendServices): void {
  const lifetime = new AbortController();
  const actions = createProductActions(ctx, lifetime.signal);
  const taskClient = new WatchdogTaskClient();
  const taskSubmissions = new Map<string, { session: SessionBinding['session']; prepared: PreparedTaskExecution }>();
  const activeTaskExecutions = new Map<string, Promise<void>>();
  ctx.effect(() => () => {
    for (const submission of taskSubmissions.values()) submission.prepared.abandon();
    taskSubmissions.clear();
  }, 'clawmaster: pending task submissions');
  const scheduleClient = new WatchdogScheduleClient();
  ctx.effect(() => () => scheduleClient.dispose(), 'clawmaster: schedule client');
  const runtimeClient = new RuntimeHealthClient();
  ctx.effect(() => () => runtimeClient.dispose(), 'clawmaster: component health client');
  ctx.effect(() => () => taskClient.dispose(), 'clawmaster: business task client');
  const initialEntry = createInitialEntry(ctx, lifetime.signal);
  const onboarding = ctx.settingsScope.bind({ namespace: ONBOARDING_NAMESPACE, decode: decodeOnboarding });
  ctx.effect(() => () => lifetime.abort(), 'clawmaster: navigation lifetime');
  const selectedLocale = (): ProductLocale => ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US';
  // A panel that throws during render would otherwise leave its region blank, or blank the window
  // when the shell's own tree is the one that threw. Every surface registered below carries its own
  // boundary so the failure stays local, visible and retryable.
  function bounded<P extends object>(scope: string, Panel: ComponentType<P>): ComponentType<P> {
    return function BoundedPanel(props: P) {
      return <RenderBoundary locale={selectedLocale()} scope={scope}><Panel {...props} /></RenderBoundary>;
    };
  }
  function useLocale(): ProductLocale {
    const snapshot = useSnapshot(ctx.locale);
    return snapshot.active.startsWith('zh') ? 'zh-CN' : 'en-US';
  }
  ctx.effect(() => {
    const previousTitle = document.title;
    const applyTitle = () => {
      if (document.title !== 'ClawMaster') document.title = 'ClawMaster';
    };
    applyTitle();
    const titleObserver = new MutationObserver(applyTitle);
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    const style = document.createElement('style');
    style.dataset.plugin = PLUGIN_ID;
    const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="dsh-style-nonce"]')?.content;
    if (styleNonce) style.nonce = styleNonce;
    style.textContent = `${styles}\n${taskStyles}`;
    document.head.appendChild(style);
    return () => {
      titleObserver.disconnect();
      style.remove();
      if (document.title === 'ClawMaster') document.title = previousTitle;
    };
  }, 'clawmaster: scoped frontend styles');

  ctx.effect(() => ctx.theme.overrideTokens(PLUGIN_ID, {
    '--dsw-alias-brand-primary': { light: '#2563eb', dark: '#86adff' },
    '--dsw-alias-bg-base': { light: '#fcfcfa', dark: '#16181d' },
    '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#1e2128' },
    '--dsw-alias-bg-layer-2': { light: '#f5f6f8', dark: '#272b33' },
    '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#252933' },
    '--dsw-alias-label-primary': { light: '#202632', dark: '#edf0f5' },
    '--dsw-alias-label-secondary': { light: '#697383', dark: '#adb6c5' },
    '--dsw-alias-border-l1': { light: '#e8eaef', dark: '#343a46' },
    '--dsw-alias-border-l2': { light: '#d4d9e3', dark: '#495162' },
    '--dsw-specific-sidebar-fill': { light: '#f3f4f6', dark: '#1a1d23' },
  }), 'clawmaster: light and dark palette');

  for (const [slot, component] of [
    ['sidebar.brand.mark', BrandMark],
    ['sidebar.brand.name', BrandName],
    ['conversation.hero.brand.mark', HeroMark],
  ] as const) {
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot }, component));
  }

  function ConnectedWorkbench({ useSessionPendingInteraction }: WorkbenchRuntimeProps) {
    const locale = useLocale();
    const draft = useSnapshot(actions.draft);
    const interactions = useSessionPendingInteraction(value => value);
    const snapshot = useSnapshot(ctx.sessions.list);
    const workspaces = useSnapshot(ctx.workspaces.list);
    const connection = useSnapshot(ctx.connection.state);
    const taskState = useSyncExternalStore(taskClient.subscribe, taskClient.getSnapshot, taskClient.getSnapshot);
    const scheduleState = useSyncExternalStore(scheduleClient.subscribe, scheduleClient.getSnapshot, scheduleClient.getSnapshot);
    const runtimeState = useSyncExternalStore(runtimeClient.subscribe, runtimeClient.getSnapshot, runtimeClient.getSnapshot);
    useEffect(() => { void runtimeClient.refresh(); }, []);
    const taskSummary = taskAttentionSummary(taskState.tasks);
    const [model, setModel] = useState<'unverified' | 'verified'>('unverified');
    useEffect(() => {
      const eventSources = snapshot.ids.flatMap(id => {
        const binding = ctx.sessions.binding(id);
        return binding ? [binding.eventSource] : [];
      });
      return observeModelResponses(eventSources, () => setModel('verified'));
    }, [ctx.sessions, snapshot.ids]);
    return <Workbench
      health={{ app: connection ?? 'connecting', model,
        schedule: { error: scheduleState.error !== null, observedAt: scheduleState.observedAt, total: scheduleState.workerSummary?.total ?? null,
          online: scheduleState.workerSummary?.online ?? 0, offline: scheduleState.workerSummary?.offline ?? 0, degraded: scheduleState.workerSummary?.degraded ?? 0,
          failed: scheduleState.attentionSummary?.failed ?? 0, uncertain: scheduleState.attentionSummary?.uncertain ?? 0 },
        business: { total: taskSummary.total, review: taskSummary.awaitingReview, failed: taskSummary.failed, overdue: taskSummary.overdue, error: taskState.error !== null },
        components: { observed: runtimeState.observed, available: runtimeState.available, components: runtimeState.components,
          disabled: runtimeState.disabled.length, refused: runtimeState.refused, observedAt: runtimeState.observedAt } }}
      locale={locale}
      sessions={recentSessions(snapshot, workspaces.archivedSessionIds, locale, interactions)}
      sessionsLoading={snapshot.phase === 'pending' || workspaces.phase === 'pending'}
      connectionLabel={connectionLabel(connection, locale)}
      connected={connection === 'connected'}
      draft={draft}
      onDraft={actions.updateDraft}
      onDraftSession={actions.openDraftSession}
      onStart={(goal, cadence) => actions.start(goal, cadence, locale)}
      onModule={module => actions.open(module, locale)}
      onOpenSession={id => ctx.uiWorkspace.openSession(id)}
      onRefresh={async () => { await ctx.sessions.refresh(); await runtimeClient.refresh(); }}
      businessTasks={<><TaskBoard client={taskClient} locale={locale}
        sessions={recentSessions(snapshot, workspaces.archivedSessionIds, locale, interactions)}
        onOpenSession={id => ctx.uiWorkspace.openSession(id)}
        onPrepareExecution={(task, sessionId) => prepareTaskSubmission(task, sessionId, locale)}
        onAbandonExecution={requestId => abandonTaskExecution(requestId)}
        onRunExecution={task => runTaskExecution(task, locale)} />
        <ScheduleBoard client={scheduleClient} locale={locale} sessions={recentSessions(snapshot, workspaces.archivedSessionIds, locale, interactions)}
          onOpenSession={id => ctx.uiWorkspace.openSession(id)} /></>}
    />;
  }

  function prepareTaskSubmission(task: TaskRecord, targetId: string, locale: ProductLocale): string {
    const sessionId = targetId as SessionId;
    const binding = ctx.sessions.binding(sessionId);
    if (!binding) throw new Error('The selected DSH Session is unavailable.');
    const prepared = prepareTaskExecution(task, locale, binding.session);
    taskSubmissions.set(prepared.requestId, { session: binding.session, prepared });
    return prepared.requestId;
  }

  function abandonTaskExecution(requestId: string): void {
    taskSubmissions.get(requestId)?.prepared.abandon();
    taskSubmissions.delete(requestId);
  }

  function runTaskExecution(task: TaskRecord, locale: ProductLocale): Promise<void> {
    if (!task.execution) throw new Error('Task execution has no persisted request identity.');
    const requestId = task.execution.requestId;
    const active = activeTaskExecutions.get(requestId);
    if (active) return active;
    const operation = dispatchTaskExecution(task, locale, requestId);
    activeTaskExecutions.set(requestId, operation);
    void operation.finally(() => {
      if (activeTaskExecutions.get(requestId) === operation) activeTaskExecutions.delete(requestId);
    }).catch(() => {});
    return operation;
  }

  async function dispatchTaskExecution(task: TaskRecord, locale: ProductLocale, requestId: string): Promise<void> {
    const sessionId = task.execution!.sessionId as SessionId;
    const pending = taskSubmissions.get(requestId);
    const session = pending?.session ?? ctx.sessions.binding(sessionId)?.session;
    if (!session) throw new Error('The selected DSH Session is unavailable.');
    try {
      const recordOutcome = (record: TaskRecord) => taskClient.recordExecutionOutcome(record);
      if (pending) await pending.prepared.submit(task, locale, recordOutcome, lifetime.signal);
      else await retryTaskExecution(task, session, recordOutcome, lifetime.signal);
    } catch (error) {
      pending?.prepared.abandon();
      throw error;
    } finally { taskSubmissions.delete(requestId); }
    ctx.uiWorkspace.openSession(sessionId);
  }

  function ConnectedCRM() { return <CRM locale={useLocale()} />; }
  function ConnectedERP() { return <ERP locale={useLocale()} />; }
  const openWatchdog = (): void => { ctx.layout.selectPanel('clawmaster' as MainPanelId); };
  async function acknowledgeTutorial(): Promise<void> {
    if (!await acknowledgeOnboarding(onboarding)) throw new Error('Tutorial acknowledgement did not persist');
    lifetime.signal.throwIfAborted();
  }
  function TutorialOnboarding({ complete, openSection }: { complete(): void; openSection(id: string): void }) {
    const locale = useLocale();
    const state = useSnapshot(onboarding);
    const sessions = useSnapshot(ctx.sessions.list);
    const workspaces = useSnapshot(ctx.workspaces.list);
    const history = sessions.ids.length > 0 || sessions.current !== undefined
      || workspaces.items.length > 0 || workspaces.archivedSessionIds.length > 0;
    const ready = sessions.phase === 'ready' && workspaces.phase === 'ready'
      && (state.mode === 'memory' || state.status !== 'loading');
    const acknowledged = (state.value?.acknowledgedVersion ?? 0) >= ONBOARDING_VERSION;
    useEffect(() => { if (ready && (history || acknowledged)) complete(); }, [ready, history, acknowledged, complete]);
    if (!ready || history || acknowledged) return null;
    const finish = async (action?: () => void) => { await acknowledgeTutorial(); action?.(); complete(); };
    return <WatchdogTutorialDialog locale={locale}
      onSkip={() => finish()}
      onFinish={() => finish(openWatchdog)}
      onSettings={section => finish(() => openSection(section))}
    />;
  }
  function TutorialSettings({ close }: { close(): void }) {
    const locale = useLocale();
    return <div className="cm-tutorial-settings"><p>{onboardingCopy(locale).reviewHint}</p>
      <WatchdogTutorial locale={locale} onFinish={async () => { await acknowledgeTutorial(); close(); openWatchdog(); }} />
    </div>;
  }
  const BoundedTutorialOnboarding = bounded('settings.onboarding', TutorialOnboarding);
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'clawmaster-watchdog', order: -200,
  }, BoundedTutorialOnboarding));
  const BoundedTutorialSettings = bounded('settings.section', TutorialSettings);
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'clawmaster-watchdog', order: 15,
    label: () => onboardingCopy(selectedLocale()).settingsTitle,
  }, BoundedTutorialSettings));
  function ComponentSettings({ module, close }: { module: 'crm' | 'erp'; close(): void }) {
    const locale = useLocale();
    const copy = productCopy(locale);
    const connection = useSnapshot(ctx.connection.state);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<'actionError' | 'toolDisabled'>();
    return <div className="cm-component-settings">
      <p>{copy[`${module}Hint`]}</p>
      {error && <p role="alert">{copy[error]}</p>}
      <button type="button" disabled={busy || connection !== 'connected'} onClick={async () => {
        setBusy(true); setError(undefined);
        try { await actions.open(module, locale); close(); }
        catch (reason) { setError(reason instanceof ProductNavigationError ? reason.code : 'actionError'); }
        finally { setBusy(false); }
      }}>{busy ? copy.preparing : copy.openInSidebar}</button>
    </div>;
  }
  observeBetterSidebar(ctx, betterSidebar => {
    const unregister: (() => void)[] = [];
    try {
      for (const [module, Component, order] of [['crm', bounded('crm', ConnectedCRM), 200], ['erp', bounded('erp', ConnectedERP), 210]] as const) {
        unregister.push(betterSidebar.registerTab({
          id: enterpriseTabTypes[module], single: true, order,
          title: () => productCopy(selectedLocale())[module],
          description: () => productCopy(selectedLocale())[`${module}Hint`],
          icon: size => <WorkbenchIcon size={size} />, component: () => <Component />,
          settings: { render: ({ close }) => <RenderBoundary locale={selectedLocale()} scope={`${module}.settings`}><ComponentSettings module={module} close={close} /></RenderBoundary> },
        }));
      }
    } catch (error) {
      for (const dispose of unregister.reverse()) dispose();
      throw error;
    }
    return () => { for (const dispose of unregister.reverse()) dispose(); };
  });
  function InitialEntry({ usePanelInfo }: InitialEntryProps) {
    const selected = usePanelInfo(panel => panel.activePanelId);
    useEffect(() => { initialEntry.start(selected); }, [selected]);
    return null;
  }
  ctx.slots.inject('main', () => {
    const unregister = ctx.slots.register({ name: 'main', key: 'clawmaster' }, bounded('main', ConnectedWorkbench));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'clawmaster-initial-entry',
    }, InitialEntry));
    return () => { initialEntry.dispose(); unregister(); };
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'clawmaster', order: -100, label: () => productCopy(selectedLocale()).watchdog,
  }, WorkbenchIcon));
}
