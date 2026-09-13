import { useEffect, useState, useSyncExternalStore } from 'react';
import { BrandMark, BrandName, HeroMark, Workbench, WorkbenchIcon } from './Workbench.tsx';
import { connectionLabel, enterpriseTabTypes, recentSessions, type FrontendServices, type Observable, type WorkbenchRuntimeProps } from './services.ts';
import { productCopy, type ProductLocale } from './locales/frontend.ts';
import { createProductActions, ProductNavigationError } from './navigation.ts';
import { createInitialEntry, type InitialEntryProps } from './initial-entry.ts';
import { CRM, ERP } from './BusinessModules.tsx';
import { acknowledgeOnboarding, decodeOnboarding, ONBOARDING_NAMESPACE, ONBOARDING_VERSION } from './onboarding.ts';
import { WatchdogTutorial, WatchdogTutorialDialog } from './WatchdogTutorial.tsx';
import { onboardingCopy } from './locales/onboarding.ts';
import type { MainPanelId } from './services.ts';
import styles from './styles.css';

export const name = 'clawmaster-frontend';
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'connection', 'uiWorkspace', 'layout', 'locale', 'betterSidebar', 'settingsScope'];
const PLUGIN_ID = '@clawmaster/dsh-frontend';

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
  const initialEntry = createInitialEntry(ctx, lifetime.signal);
  const onboarding = ctx.settingsScope.bind({ namespace: ONBOARDING_NAMESPACE, decode: decodeOnboarding });
  ctx.effect(() => () => lifetime.abort(), 'clawmaster: navigation lifetime');
  const selectedLocale = (): ProductLocale => ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US';
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
    style.textContent = styles;
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
    return <Workbench
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
      onRefresh={() => ctx.sessions.refresh()}
    />;
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
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'clawmaster-watchdog', order: -200,
  }, TutorialOnboarding));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'clawmaster-watchdog', order: 15,
    label: () => onboardingCopy(selectedLocale()).settingsTitle,
  }, TutorialSettings));
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
  for (const [module, Component, order] of [['crm', ConnectedCRM, 200], ['erp', ConnectedERP, 210]] as const) {
    ctx.effect(() => ctx.betterSidebar.registerTab({
      id: enterpriseTabTypes[module], single: true, order,
      title: () => productCopy(selectedLocale())[module],
      description: () => productCopy(selectedLocale())[`${module}Hint`],
      icon: size => <WorkbenchIcon size={size} />, component: () => <Component />,
      settings: { render: ({ close }) => <ComponentSettings module={module} close={close} /> },
    }), `clawmaster: ${module} sidebar component`);
  }
  function InitialEntry({ usePanelInfo }: InitialEntryProps) {
    const selected = usePanelInfo(panel => panel.activePanelId);
    useEffect(() => { initialEntry.start(selected); }, [selected]);
    return null;
  }
  ctx.slots.inject('main', () => {
    const unregister = ctx.slots.register({ name: 'main', key: 'clawmaster' }, ConnectedWorkbench);
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'clawmaster-initial-entry',
    }, InitialEntry));
    return () => { initialEntry.dispose(); unregister(); };
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'clawmaster', order: -100, label: () => productCopy(selectedLocale()).watchdog,
  }, WorkbenchIcon));
}
