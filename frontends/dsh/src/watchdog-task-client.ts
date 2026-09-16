/** Browser transport retains exact task writes until the server confirms their outcome. */
import { z } from 'zod';
import { taskHistorySchema, taskListSchema, taskRecordSchema, taskRequestSchema, type TaskRecord, type TaskRequest } from './watchdog-task-format.ts';

const tasksPath = '/api/clawmaster/tasks';
const failureSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type TaskClientError = 'network' | 'invalid' | 'denied' | 'conflict' | 'unavailable' | 'tooLarge';
export interface TaskClientState {
  tasks: TaskRecord[];
  nextOffset: number | null;
  selected: TaskRecord | null;
  history: TaskRecord[];
  nextAfter: number | null;
  loading: boolean;
  saving: boolean;
  pending: boolean;
  error: TaskClientError | null;
}

/** Owns bounded pages and one unresolved command across management-panel remounts. */
export class WatchdogTaskClient {
  private state: TaskClientState = { tasks: [], nextOffset: null, selected: null, history: [], nextAfter: null,
    loading: false, saving: false, pending: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly request: typeof fetch;
  private readonly nextId: () => string;
  private pendingRequest: TaskRequest | undefined;
  private readVersion = 0;
  private disposed = false;

  constructor(request: typeof fetch = globalThis.fetch.bind(globalThis), nextId: () => string = () => crypto.randomUUID()) {
    this.request = request;
    this.nextId = nextId;
  }
  /** Stable snapshot suitable for React's external-store subscription. */
  getSnapshot = (): TaskClientState => this.state;
  /** Subscribe until the returned disposer is called. */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private set(patch: Partial<TaskClientState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** Ignore late responses after plugin unload; disposal never starts a request. */
  dispose(): void { this.disposed = true; this.readVersion++; this.listeners.clear(); }

  private async read(action: () => Promise<Partial<TaskClientState>>): Promise<void> {
    if (this.disposed || this.state.saving) return;
    const version = ++this.readVersion;
    this.set({ loading: true, error: null });
    try {
      const result = await action();
      if (version === this.readVersion) this.set(result);
    } catch (error) {
      if (version === this.readVersion) this.set({ error: error instanceof TaskTransportFailure ? error.kind : 'network' });
    } finally { if (version === this.readVersion) this.set({ loading: false }); }
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.request(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new TaskTransportFailure(response.status === 403 ? 'denied' : response.status === 413 ? 'tooLarge' : 'unavailable');
    try { return await response.json(); } catch { throw new TaskTransportFailure('invalid'); }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new TaskTransportFailure('invalid');
    return parsed.data;
  }
  /** Reload the first management page; retained write requests and selected revisions stay unchanged. */
  async refresh(): Promise<void> {
    await this.read(async () => this.parse(taskListSchema, await this.json(`${tasksPath}?limit=50`)));
  }
  /** Fetch the next bounded page and keep one current row per task identifier. */
  async more(): Promise<void> {
    const next = this.state.nextOffset;
    if (next === null || this.state.loading) return;
    await this.read(async () => {
      const page = this.parse(taskListSchema, await this.json(`${tasksPath}?limit=50&offset=${next}`));
      const records = new Map(this.state.tasks.map(task => [task.id, task]));
      for (const task of page.tasks) records.set(task.id, task);
      return { ...page, tasks: [...records.values()] };
    });
  }
  /** Explicitly replace the selected revision and load its first evidence-history page. */
  async select(id: string): Promise<void> {
    await this.read(async () => {
      const encoded = encodeURIComponent(id);
      const selected = this.parse(taskRecordSchema, await this.json(`${tasksPath}?id=${encoded}`));
      if (selected.id !== id) throw new TaskTransportFailure('invalid');
      const history = this.parse(taskHistorySchema, await this.json(`${tasksPath}?id=${encoded}&history=true&limit=20`));
      if (history.tasks.some(task => task.id !== id)) throw new TaskTransportFailure('invalid');
      return { selected, history: history.tasks, nextAfter: history.nextAfter };
    });
  }
  /** Continue history from the server's last returned revision. */
  async moreHistory(): Promise<void> {
    const { selected, nextAfter, loading } = this.state;
    if (!selected || nextAfter === null || loading) return;
    await this.read(async () => {
      const history = this.parse(taskHistorySchema, await this.json(`${tasksPath}?id=${encodeURIComponent(selected.id)}&history=true&limit=20&after=${nextAfter}`));
      if (history.tasks.some(task => task.id !== selected.id || task.revision <= nextAfter)) throw new TaskTransportFailure('invalid');
      return { history: [...this.state.history, ...history.tasks], nextAfter: history.nextAfter };
    });
  }

  /** Save against the revision actually reviewed; only exact pending requests may retry. */
  async command(id: string, revision: number, command: TaskRequest['command']): Promise<boolean> {
    if (this.disposed || this.state.saving || this.pendingRequest) return false;
    const parsed = taskRequestSchema.safeParse({ id, revision, command, commandId: this.nextId() });
    if (!parsed.success) { this.set({ error: 'invalid' }); return false; }
    this.pendingRequest = parsed.data;
    return this.send();
  }
  /** Retry a possibly committed write with its original body and idempotency identifier. */
  async retry(): Promise<boolean> {
    return !this.disposed && !this.state.saving && this.pendingRequest !== undefined ? this.send() : false;
  }
  private async send(): Promise<boolean> {
    const request = this.pendingRequest!;
    this.readVersion++;
    this.set({ saving: true, loading: false, pending: true, error: null });
    try {
      const response = await this.request(`${tasksPath}/command`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      let body: unknown;
      try { body = await response.json(); } catch { throw new TaskTransportFailure('invalid'); }
      if (!response.ok) {
        const failure = failureSchema.safeParse(body);
        if (!failure.success) throw new TaskTransportFailure('invalid');
        // A server-side rejection is definitive; an unavailable server may have committed before failing.
        if ([400, 403, 404, 409, 413].includes(response.status)) { this.pendingRequest = undefined; this.set({ pending: false }); }
        throw new TaskTransportFailure(response.status === 403 ? 'denied' : failure.data.error.code === 'revision_conflict' ? 'conflict'
          : response.status === 413 || failure.data.error.code === 'response_too_large' ? 'tooLarge' : 'unavailable');
      }
      const task = this.parse(taskRecordSchema, body);
      if (task.id !== request.id || task.revision !== request.revision + 1) throw new TaskTransportFailure('invalid');
      this.pendingRequest = undefined;
      const records = this.state.tasks.filter(row => row.id !== task.id);
      this.set({ selected: task, tasks: [task, ...records], history: [], nextAfter: null, pending: false });
      return true;
    } catch (error) {
      this.set({ error: error instanceof TaskTransportFailure ? error.kind : 'network' });
      return false;
    } finally { this.set({ saving: false }); }
  }
}

class TaskTransportFailure extends Error { constructor(readonly kind: TaskClientError) { super(kind); } }
