/** First-load navigation without creating a Session or Workspace. */
import type { FrontendServices, MainPanelId } from './services.ts';

/** Public root-slot hook supplied by DSH's layout plugin. */
export interface InitialEntryProps {
  usePanelInfo<T>(selector: (panel: { readonly activePanelId: MainPanelId | null }) => T): T;
}

/**
 * Select WatchDog once when both durable lists prove the user has no history.
 * The owning main-slot registration must dispose this controller on removal.
 * @param ctx - Public DSH list and navigation services.
 * @param lifetime - Frontend plugin lifetime.
 * @returns An idempotent initial attempt and its subscription disposer.
 */
export function createInitialEntry(
  ctx: Pick<FrontendServices, 'sessions' | 'workspaces' | 'layout'>,
  lifetime: AbortSignal,
): { start(panel: MainPanelId | null): void; dispose(): void } {
  let attempted = false;
  let stopped = false;
  let navigation: AbortSignal | undefined;
  const subscriptions: (() => void)[] = [];

  const dispose = (): void => {
    if (stopped) return;
    stopped = true;
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    navigation?.removeEventListener('abort', dispose);
    lifetime.removeEventListener('abort', dispose);
  };
  const hasHistory = (): boolean => {
    const sessions = ctx.sessions.list.getSnapshot();
    const workspaces = ctx.workspaces.list.getSnapshot();
    return sessions.current !== undefined || sessions.ids.length > 0
      || workspaces.items.length > 0 || workspaces.archivedSessionIds.length > 0;
  };
  const reconcile = (): void => {
    if (stopped) return;
    if (hasHistory()) { dispose(); return; }
    if (ctx.sessions.list.getSnapshot().phase !== 'ready'
      || ctx.workspaces.list.getSnapshot().phase !== 'ready') return;
    dispose();
    ctx.layout.selectPanel('clawmaster' as MainPanelId);
  };
  return {
    start(panel) {
      if (attempted || stopped) return;
      attempted = true;
      if (panel !== null || lifetime.aborted || hasHistory()) { dispose(); return; }
      navigation = ctx.layout.beginNavigation();
      navigation.addEventListener('abort', dispose, { once: true });
      lifetime.addEventListener('abort', dispose, { once: true });
      subscriptions.push(ctx.sessions.list.subscribe(reconcile), ctx.workspaces.list.subscribe(reconcile));
      reconcile();
    },
    dispose,
  };
}
