/** Public DSH services consumed by the product UI; DSH owns Session execution. */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { Context } from '@deepseek-ai/cordis';
import type { ReactNode } from 'react';
import { productCopy, type ProductLocale } from './locales/frontend.ts';
import type { OnboardingScope, OnboardingSettings } from './onboarding.ts';
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client';

export type SessionId = Branded<'SessionId'>;
export type SessionRequestId = Branded<'SessionRequestId'>;
export type TaskStatus = 'approval' | 'question' | 'planReview' | 'running' | 'idle';
export type PendingInteractions = ReadonlyMap<SessionId, { readonly kind: string }>;
/** Global standard hook supplied to the main slot by DSH ui-session. */
export interface WorkbenchRuntimeProps { useSessionPendingInteraction<T>(selector: (pending: PendingInteractions) => T): T; }
export type WorkspaceId = Branded<'WorkspaceId'>;
export type MainPanelId = Branded<'MainPanelId'>;
/** Better Sidebar tab types shared by component registration and explicit navigation. */
export const enterpriseTabTypes = { crm: 'clawmaster:crm', erp: 'clawmaster:erp' } as const;
export interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void; }
export interface SessionRow {
  id: SessionId; title?: string; displayTitle: string; cwd: string;
  updatedAt: number; running: boolean; blank: boolean; origin?: 'subagent';
}
export interface SessionListSnapshot {
  ids: readonly SessionId[]; byId: Readonly<Record<string, SessionRow>>;
  current?: SessionId; phase: 'pending' | 'ready';
}
export interface WorkspaceListSnapshot {
  items: readonly { workspaceId: WorkspaceId; path: string; title: string; sessionIds: readonly SessionId[] }[];
  archivedSessionIds: readonly SessionId[]; phase: 'pending' | 'ready';
}
export interface BetterSidebarService {
  /** Register a native tab and its existing Better Sidebar settings card. */
  registerTab(descriptor: {
    id: string; title: () => string; description: () => string; single: boolean; order: number;
    icon: (size: number) => ReactNode; component: () => ReactNode;
    settings: { render: (props: { close(): void }) => ReactNode };
  }): () => void;
  isTabEnabled(id: string): boolean;
  openTab(seed: { type: string; title?: string; target?: 'right' | 'bottom' }, scope: { sessionId: SessionId; cwd: string }): void;
}
export interface FrontendServices extends Pick<Context, 'get' | 'on'> {
  slots: {
    inject(name: string, effect: () => (() => void)): unknown;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  theme: { overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void };
  sessions: {
    list: Observable<SessionListSnapshot>;
    refresh(): Promise<void>;
    create(options: { workspaceId: WorkspaceId; cwd: string }): Promise<SessionId>;
    binding(id: SessionId): { session: {
      beginSubmission(input: { mode: 'queue'; text: string; attachments: readonly [] }): { requestId: SessionRequestId; abandon(): void };
      prompt(content: { type: 'text'; text: string }[], mode: 'queue', signal?: AbortSignal, requestId?: SessionRequestId): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>;
    }; eventSource: Observable<SessionEventWindow> } | undefined;
  };
  workspaces: { list: Observable<WorkspaceListSnapshot> };
  connection: { state: Observable<'connected' | 'disconnected' | 'connecting' | undefined> };
  uiWorkspace: { openSession(id: SessionId): void };
  layout: { selectPanel(key: MainPanelId | null): void; beginNavigation(): AbortSignal };
  locale: Observable<{ active: string }>;
  settingsScope: { bind(spec: { namespace: string; decode(value: unknown): OnboardingSettings | undefined }): OnboardingScope };
  effect(setup: () => (() => void), label?: string): unknown;
}

/** Read the optional service through Cordis instead of its throwing proxy property access.
 * @param ctx - Cordis service context.
 * @returns the active Better Sidebar service, if available.
 */
export function getBetterSidebar(ctx: Pick<FrontendServices, 'get'>): BetterSidebarService | undefined {
  return ctx.get('betterSidebar') as BetterSidebarService | undefined;
}

/** Follow Better Sidebar's active lifetime and register feature tabs whenever it becomes available.
 * @param ctx - Cordis service context.
 * @param register - register product tabs and return their disposer.
 * @returns nothing; registration is owned by the calling Cordis effect.
 */
export function observeBetterSidebar(
  ctx: Pick<FrontendServices, 'effect' | 'get' | 'on'>,
  register: (service: BetterSidebarService) => () => void,
): void {
  ctx.effect(() => {
    let active: BetterSidebarService | undefined;
    let disposeTabs: (() => void) | undefined;
    const refresh = () => {
      const next = getBetterSidebar(ctx);
      if (next === active) return;
      disposeTabs?.();
      disposeTabs = undefined;
      active = next;
      if (next === undefined) return;
      try {
        disposeTabs = register(next);
      } catch (error) {
        console.error('ClawMaster: Better Sidebar tabs could not be registered', error);
      }
    };
    const stopService = ctx.on('internal/service', name => {
      if (name === 'betterSidebar') refresh();
    });
    const stopStatus = ctx.on('internal/status', refresh);
    refresh();
    return () => {
      stopStatus();
      stopService();
      disposeTabs?.();
    };
  }, 'clawmaster: optional Better Sidebar tabs');
}

/** Project durable user Sessions, excluding blank, archived and delegated entries. */
export function recentSessions(snapshot: SessionListSnapshot, archivedSessionIds: readonly SessionId[], locale: ProductLocale = 'zh-CN', pending: PendingInteractions = new Map()) {
  const archived = new Set(archivedSessionIds);
  return snapshot.ids.map(id => snapshot.byId[id])
    .filter((row): row is SessionRow => row !== undefined && !row.blank && row.origin !== 'subagent' && !archived.has(row.id))
    .map(row => {
      const kind = pending.get(row.id)?.kind;
      // Only DSH's established user-interaction kinds receive attention labels.
      const status: TaskStatus = kind === 'approval' || kind === 'question' ? kind
        : kind === 'plan-review' ? 'planReview' : row.running ? 'running' : 'idle';
      const attention = status === 'approval' || status === 'question' || status === 'planReview';
      return { id: row.id, title: row.displayTitle || row.title || productCopy(locale).untitled, updatedAt: row.updatedAt, running: row.running, status, attention };
    })
    .sort((a, b) => Number(b.attention) - Number(a.attention) || b.updatedAt - a.updatedAt);
}

/** Unknown connection state never implies an established connection. */
export function connectionLabel(state: 'connected' | 'disconnected' | 'connecting' | undefined, locale: ProductLocale = 'zh-CN'): string {
  const copy = productCopy(locale);
  return state === 'connected' ? copy.connected : state === 'disconnected' ? copy.disconnected : copy.connecting;
}
