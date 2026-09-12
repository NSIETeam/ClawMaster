import { useSyncExternalStore } from 'react';
import { BrandMark, BrandName, HeroMark, Workbench, WorkbenchIcon } from './Workbench';
import { connectionLabel, recentSessions, watchdogWorkspaceId, type FrontendServices, type Observable } from './services';
import styles from './styles.css';

export const name = 'clawmaster-frontend';
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'connection', 'uiWorkspace'];
const PLUGIN_ID = '@clawmaster/dsh-frontend';

function useSnapshot<T>(source: Observable<T>): T {
  return useSyncExternalStore(
    listener => source.subscribe(listener),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  );
}

/** Adds browser components through public DSH slots, with no backend or transport. */
export function apply(ctx: FrontendServices): void {
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

  function ConnectedWorkbench() {
    const snapshot = useSnapshot(ctx.sessions.list);
    const workspaces = useSnapshot(ctx.workspaces.list);
    const connection = useSnapshot(ctx.connection.state);
    const managedWorkspaceId = watchdogWorkspaceId(workspaces);
    return <Workbench
      sessions={recentSessions(snapshot, workspaces.archivedSessionIds)}
      sessionsLoading={snapshot.phase === 'pending' || workspaces.phase === 'pending'}
      connectionLabel={connectionLabel(connection)}
      connected={connection === 'connected'}
      watchdogReady={managedWorkspaceId !== undefined}
      onNewSession={() => {
        if (managedWorkspaceId !== undefined) ctx.uiWorkspace.startSession(managedWorkspaceId);
      }}
      onOpenSession={id => ctx.uiWorkspace.openSession(id)}
      onRefresh={() => ctx.sessions.refresh()}
    />;
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'clawmaster',
  }, ConnectedWorkbench));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'clawmaster', order: -100, label: 'WatchDog',
  }, WorkbenchIcon));
}
