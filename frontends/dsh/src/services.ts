/** Read-only subset of the public DSH 0.1.5-rc.2 browser services we consume. */
export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface SessionRow {
  id: string;
  title?: string;
  displayTitle: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  origin?: 'subagent';
}

export interface SessionListSnapshot {
  ids: readonly string[];
  byId: Readonly<Record<string, SessionRow>>;
  phase: 'pending' | 'ready';
}

export interface WorkspaceListSnapshot {
  items: readonly {
    workspaceId: string;
    path: string;
    title: string;
  }[];
  archivedSessionIds: readonly string[];
  phase: 'pending' | 'ready';
}

export const WATCHDOG_WORKSPACE_TITLE = 'WatchDog 托管空间';

export interface FrontendServices {
  slots: {
    inject(name: string, effect: () => (() => void)): unknown;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  theme: {
    overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void;
  };
  sessions: {
    list: Observable<SessionListSnapshot>;
    refresh(): Promise<void>;
  };
  workspaces: {
    list: Observable<WorkspaceListSnapshot>;
  };
  connection: {
    state: Observable<'connected' | 'disconnected' | 'connecting' | undefined>;
  };
  uiWorkspace: {
    startSession(workspaceId?: string): void;
    openSession(id: string): void;
  };
  effect(setup: () => (() => void), label?: string): unknown;
}

/** Resolve only the system-owned WatchDog Workspace; never fall back to user history. */
export function watchdogWorkspaceId(snapshot: WorkspaceListSnapshot): string | undefined {
  return snapshot.items.find(workspace => workspace.title === WATCHDOG_WORKSPACE_TITLE)?.workspaceId;
}

/** Presentation mapping only. DSH owns selection, persistence, and session state. */
export function recentSessions(snapshot: SessionListSnapshot, archivedSessionIds: readonly string[]) {
  const archived = new Set(archivedSessionIds);
  return snapshot.ids
    .map(id => snapshot.byId[id])
    .filter((row): row is SessionRow => row !== undefined && !row.blank && row.origin !== 'subagent' && !archived.has(row.id))
    .map(row => ({
      id: row.id,
      title: row.displayTitle || row.title || '未命名会话',
      updatedAt: row.updatedAt,
      running: row.running,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function connectionLabel(state: 'connected' | 'disconnected' | 'connecting' | undefined): string {
  if (state === 'connected') return '已连接';
  if (state === 'disconnected') return '连接已断开';
  return '正在连接';
}
