/** User-triggered navigation using DSH Sessions and Better Sidebar's native panels. */
import { z } from 'zod';
import { flushSync } from 'react-dom';
import { productCopy, type ProductLocale, type ProductModule } from './locales/frontend.ts';
import { enterpriseTabTypes, type FrontendServices, type SessionId, type WorkspaceId } from './services.ts';

export type WatchdogCadence = 'once' | 'hourly' | 'daily';
const allocation = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) }).strict();

/** Compose the submitted user request; DSH records and executes it normally. */
export function watchdogPrompt(goal: string, cadence: WatchdogCadence, locale: ProductLocale): string {
  const copy = productCopy(locale);
  const instruction = cadence === 'hourly' ? copy.scheduleHourlyPrompt : cadence === 'daily' ? copy.scheduleDailyPrompt : '';
  return instruction ? `${goal.trim()}\n\n${instruction}` : goal.trim();
}

/** Navigation failures use locale-owned product messages. */
export class ProductNavigationError extends Error {
  constructor(readonly code: 'actionError' | 'toolDisabled') { super(code); }
}

/**
 * Create lazy product actions; loading the plugin allocates no directories or Sessions.
 * @param ctx - Public DSH navigation and Session services.
 * @param lifetime - Plugin lifetime; prevents navigation after disposal.
 * @param request - Authenticated same-origin Fetch, replaceable by a test carrier.
 * @returns Actions whose overlapping clicks share the in-flight operation.
 */
export function createProductActions(ctx: FrontendServices, lifetime: AbortSignal, request: typeof fetch = fetch) {
  let pending: Promise<void> | undefined;
  const exclusive = (operation: () => Promise<void>): Promise<void> => {
    if (pending) return pending;
    const attempt = operation();
    pending = attempt;
    const clear = () => { if (pending === attempt) pending = undefined; };
    void attempt.then(clear, clear);
    return attempt;
  };
  const allocate = async (kind: 'task' | 'tools', signal: AbortSignal) => {
    const response = await request('/api/clawmaster/workspace', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }), signal,
    });
    if (!response.ok) throw new ProductNavigationError('actionError');
    const value = allocation.parse(await response.json());
    return { workspaceId: value.workspaceId as WorkspaceId, cwd: value.path };
  };
  return {
    start(goal: string, cadence: WatchdogCadence, locale: ProductLocale): Promise<void> {
      return exclusive(async () => {
        const navigation = AbortSignal.any([lifetime, ctx.layout.beginNavigation()]);
        navigation.throwIfAborted();
        const target = await allocate('task', navigation);
        navigation.throwIfAborted();
        const id = await ctx.sessions.create(target);
        if (navigation.aborted) return;
        ctx.uiWorkspace.openSession(id);
        const text = watchdogPrompt(goal, cadence, locale);
        if (text) {
          const binding = ctx.sessions.binding(id);
          if (!binding) throw new ProductNavigationError('actionError');
          const result = await binding.session.prompt([{ type: 'text', text }], 'queue');
          if (!result.ok) throw new ProductNavigationError('actionError');
        }
      });
    },
    open(module: ProductModule, locale: ProductLocale): Promise<void> {
      return exclusive(async () => {
        const type = module === 'crm' || module === 'erp' ? enterpriseTabTypes[module] : module;
        if (!ctx.betterSidebar.isTabEnabled(type)) throw new ProductNavigationError('toolDisabled');
        const navigation = AbortSignal.any([lifetime, ctx.layout.beginNavigation()]);
        navigation.throwIfAborted();
        const snapshot = ctx.sessions.list.getSnapshot();
        const current = snapshot.current && snapshot.byId[snapshot.current];
        let scope: { sessionId: SessionId; cwd: string };
        if (current && !ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(current.id)) {
          scope = { sessionId: current.id, cwd: current.cwd };
        } else {
          const target = await allocate('tools', navigation);
          navigation.throwIfAborted();
          const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds);
          const reusable = snapshot.ids.map(id => snapshot.byId[id])
            .find(row => row && row.cwd === target.cwd && row.origin !== 'subagent' && !archived.has(row.id));
          scope = { sessionId: reusable?.id ?? await ctx.sessions.create(target), cwd: target.cwd };
        }
        if (navigation.aborted) return;
        let displayed: AbortSignal | undefined;
        // DSH's right Sidebar binds its Session service in a React effect.
        flushSync(() => {
          if (navigation.aborted) return;
          ctx.uiWorkspace.openSession(scope.sessionId);
          displayed = ctx.layout.beginNavigation();
        });
        if (!displayed || displayed.aborted || lifetime.aborted
          || ctx.sessions.list.getSnapshot().current !== scope.sessionId) return;
        ctx.betterSidebar.openTab({ type, title: productCopy(locale)[module], target: module === 'terminal' ? 'bottom' : 'right' }, scope);
      });
    },
  };
}
