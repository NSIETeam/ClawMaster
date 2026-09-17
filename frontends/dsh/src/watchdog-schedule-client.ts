/** Browser-only schedule transport; unresolved writes retain their exact command identity. */
import { z } from 'zod';
import type { ScheduleCommand } from './watchdog-schedule-format.ts';
import { scheduleCommandSchema } from './watchdog-schedule-format.ts';

const integer = z.number().int().nonnegative().max(8_640_000_000_000_000);
const plan = z.object({ id: z.string(), sessionId: z.string(), prompt: z.string(), active: z.boolean(), nextAt: integer.nullable(), missedCount: integer,
  missed: z.enum(['skip', 'coalesce', 'catch-up']), catchUpLimit: integer,
  record: z.object({ kind: z.enum(['every', 'at']), scheduledAt: z.string(), everySeconds: z.number().optional() }) });
const occurrence = z.object({ id: z.string(), planId: z.string(), scheduledAt: integer, expiresAt: integer,
  state: z.enum(['waiting_approval', 'ready', 'leased', 'dispatching', 'dispatched', 'uncertain', 'failed', 'cancelled']),
  attempts: integer, reason: z.string().nullable(), finishedAt: integer.nullable() });
const worker = z.object({ id: z.string(), lastHeartbeat: integer, status: z.enum(['online', 'offline', 'degraded', 'stopped']) });
const workerSummary = z.object({ total: integer, online: integer, offline: integer, degraded: integer, stopped: integer, nextAfter: integer.nullable() });
const attentionSummary = z.object({ failed: integer, uncertain: integer });
const summary = { mode: z.enum(['desktop', 'server']), workers: z.array(worker), workerSummary, attentionSummary, nextAfter: integer.nullable() };
const plans = z.object({ ...summary, records: z.array(plan) });
const instances = z.object({ ...summary, records: z.array(occurrence) });
const history = z.object({ records: z.array(z.object({ seq: integer, at: integer, action: z.string(), reason: z.string().nullable() })), nextAfter: integer.nullable() });
export type SchedulePlanView = z.infer<typeof plan>;
export type ScheduleInstanceView = z.infer<typeof occurrence>;
export type ScheduleClientError = 'network' | 'invalid' | 'denied' | 'conflict' | 'unavailable';
export interface ScheduleClientState {
  plans: SchedulePlanView[];
  nextPlan: number | null;
  selected: SchedulePlanView | null;
  instances: ScheduleInstanceView[];
  nextInstance: number | null;
  history: z.infer<typeof history>['records'];
  nextHistory: number | null;
  workers: z.infer<typeof worker>[];
  workerSummary: z.infer<typeof workerSummary> | null;
  attentionSummary: z.infer<typeof attentionSummary> | null;
  mode: 'desktop' | 'server' | null;
  observedAt: number | null;
  loading: boolean;
  saving: boolean;
  pending: boolean;
  saved: boolean;
  error: ScheduleClientError | null;
}

/** One current page per collection and one exact unconfirmed write survive panel navigation. */
export class WatchdogScheduleClient {
  private state: ScheduleClientState = { plans: [], nextPlan: null, selected: null, instances: [], nextInstance: null,
    history: [], nextHistory: null, workers: [], workerSummary: null, attentionSummary: null, mode: null, observedAt: null, loading: false, saving: false, pending: false, saved: false, error: null };
  private readonly listeners = new Set<() => void>();
  private pending: ScheduleCommand | undefined;
  private readVersion = 0;
  private disposed = false;
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis), private readonly nextId: () => string = () => crypto.randomUUID()) {}
  /** Read the stable React external-store snapshot. */
  getSnapshot = (): ScheduleClientState => this.state;
  /** Subscribe until the returned disposer runs. */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  /** Ignore late responses after plugin unload without issuing a request. */
  dispose(): void { this.disposed = true; this.readVersion++; this.listeners.clear(); }
  private set(value: Partial<ScheduleClientState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  private async get<T>(schema: z.ZodType<T>, query = ''): Promise<T> {
    const response = await this.request(`/api/clawmaster/schedules${query}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Failure(response.status === 403 ? 'denied' : response.status === 409 ? 'conflict' : 'unavailable');
    let body: unknown;
    try { body = await response.json(); } catch { throw new Failure('invalid'); }
    const value = schema.safeParse(body);
    if (!value.success) throw new Failure('invalid');
    return value.data;
  }
  private async read(action: () => Promise<Partial<ScheduleClientState>>): Promise<void> {
    if (this.disposed || this.state.saving) return;
    const version = ++this.readVersion;
    this.set({ loading: true, error: null });
    try { const value = await action(); if (version === this.readVersion) this.set(value); }
    catch (error) { if (version === this.readVersion) this.set({ error: error instanceof Failure ? error.kind : 'network' }); }
    finally { if (version === this.readVersion) this.set({ loading: false }); }
  }
  /** Read one plan page and worker heartbeat without starting or approving execution. */
  async refresh(after = 0): Promise<void> {
    await this.read(async () => {
      const value = await this.get(plans, `?limit=20&after=${after}`);
      return { plans: value.records, nextPlan: value.nextAfter, workers: value.workers, workerSummary: value.workerSummary, attentionSummary: value.attentionSummary, mode: value.mode, observedAt: Date.now() };
    });
  }
  /** Show the selected plan's occurrence page; its Session is opened separately by the user. */
  async select(selected: SchedulePlanView, after = 0): Promise<void> {
    await this.read(async () => {
      const value = await this.get(instances, `?id=${encodeURIComponent(selected.id)}&limit=20&after=${after}`);
      if (value.records.some(item => item.planId !== selected.id)) throw new Failure('invalid');
      return { selected, instances: value.records, nextInstance: value.nextAfter, workers: value.workers, workerSummary: value.workerSummary, attentionSummary: value.attentionSummary, mode: value.mode, observedAt: Date.now(), history: [], nextHistory: null };
    });
  }
  /** Page worker observations independently without replacing the selected business records. */
  async workers(after = 0): Promise<void> {
    await this.read(async () => {
      const value = await this.get(plans, `?limit=1&workersAfter=${after}`);
      return { workers: value.workers, workerSummary: value.workerSummary, attentionSummary: value.attentionSummary, mode: value.mode, observedAt: Date.now() };
    });
  }
  /** Read one immutable history page without accumulating the complete log in the WebView. */
  async history(after = 0): Promise<void> {
    const selected = this.state.selected;
    if (!selected) return;
    await this.read(async () => {
      const value = await this.get(history, `?id=${encodeURIComponent(selected.id)}&history=true&limit=20&after=${after}`);
      return { history: value.records, nextHistory: value.nextAfter };
    });
  }
  /** Retain the exact command until the server confirms success or an explicit refusal. */
  async command(command: unknown): Promise<boolean> {
    if (this.disposed || this.state.saving || this.pending) return false;
    const parsed = scheduleCommandSchema.safeParse({ commandId: this.nextId(), command });
    if (!parsed.success) { this.set({ error: 'invalid' }); return false; }
    this.pending = parsed.data;
    return this.send();
  }
  /** Retry only the original command, including its idempotency identifier. */
  async retry(): Promise<boolean> { return !this.disposed && this.pending && !this.state.saving ? this.send() : false; }
  private async send(): Promise<boolean> {
    const pending = this.pending!;
    this.readVersion++;
    this.set({ saving: true, pending: true, saved: false, loading: false, error: null });
    try {
      const response = await this.request('/api/clawmaster/schedules/command', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending) });
      let body: unknown;
      try { body = await response.json(); } catch { throw new Failure('invalid'); }
      if (!response.ok) {
        if (!z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(body).success) throw new Failure('invalid');
        if ([400, 403, 404, 409, 413].includes(response.status)) { this.pending = undefined; this.set({ pending: false }); }
        throw new Failure(response.status === 400 ? 'invalid' : response.status === 403 ? 'denied' : response.status === 409 ? 'conflict' : 'unavailable');
      }
      if (!z.object({ commandId: z.literal(pending.commandId) }).safeParse(body).success) throw new Failure('invalid');
      if ('instanceId' in pending.command) {
        const value = occurrence.safeParse(body);
        if (!value.success || value.data.id !== pending.command.instanceId || value.data.planId !== pending.command.id) throw new Failure('invalid');
        this.set({ instances: this.state.instances.map(item => item.id === value.data.id ? value.data : item) });
      } else {
        const value = plan.safeParse(body);
        if (!value.success || value.data.id !== pending.command.id) throw new Failure('invalid');
        this.set({ selected: value.data, plans: pending.command.type === 'create' ? [value.data] : this.state.plans.map(item => item.id === value.data.id ? value.data : item),
          nextPlan: null, instances: [], nextInstance: null, history: [], nextHistory: null });
      }
      this.pending = undefined;
      this.set({ pending: false, saved: true });
      return true;
    } catch (error) { this.set({ error: error instanceof Failure ? error.kind : 'network' }); return false; }
    finally { this.set({ saving: false }); }
  }
}
class Failure extends Error { constructor(readonly kind: ScheduleClientError) { super(kind); } }
