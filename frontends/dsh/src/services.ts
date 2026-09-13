/** Public DSH services consumed by the product UI; DSH owns Session execution. */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { ReactNode } from 'react';
import { productCopy, type ProductLocale } from './locales/frontend.ts';
import type { OnboardingScope, OnboardingSettings } from './onboarding.ts';

export type SessionId = Branded<'SessionId'>;
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
export interface FrontendServices {
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
      prompt(content: { type: 'text'; text: string }[], mode: 'queue'): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>;
    } } | undefined;
  };
  workspaces: { list: Observable<WorkspaceListSnapshot> };
  connection: { state: Observable<'connected' | 'disconnected' | 'connecting' | undefined> };
  uiWorkspace: { openSession(id: SessionId): void };
  layout: { selectPanel(key: MainPanelId | null): void; beginNavigation(): AbortSignal };
  locale: Observable<{ active: string }>;
  settingsScope: { bind(spec: { namespace: string; decode(value: unknown): OnboardingSettings | undefined }): OnboardingScope };
  betterSidebar: {
    /** Register a native tab and its existing Better Sidebar settings card. */
    registerTab(descriptor: {
      id: string; title: () => string; description: () => string; single: boolean; order: number;
      icon: (size: number) => ReactNode; component: () => ReactNode;
      settings: { render: (props: { close(): void }) => ReactNode };
    }): () => void;
    isTabEnabled(id: string): boolean;
    openTab(seed: { type: string; title?: string; target?: 'right' | 'bottom' }, scope: { sessionId: SessionId; cwd: string }): void;
  };
  effect(setup: () => (() => void), label?: string): unknown;
}

/** Project durable user Sessions, excluding blank, archived and delegated entries. */
export function recentSessions(snapshot: SessionListSnapshot, archivedSessionIds: readonly SessionId[], locale: ProductLocale = 'zh-CN') {
  const archived = new Set(archivedSessionIds);
  return snapshot.ids.map(id => snapshot.byId[id])
    .filter((row): row is SessionRow => row !== undefined && !row.blank && row.origin !== 'subagent' && !archived.has(row.id))
    .map(row => ({ id: row.id, title: row.displayTitle || row.title || productCopy(locale).untitled, updatedAt: row.updatedAt, running: row.running }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Unknown connection state never implies an established connection. */
export function connectionLabel(state: 'connected' | 'disconnected' | 'connecting' | undefined, locale: ProductLocale = 'zh-CN'): string {
  const copy = productCopy(locale);
  return state === 'connected' ? copy.connected : state === 'disconnected' ? copy.disconnected : copy.connecting;
}
