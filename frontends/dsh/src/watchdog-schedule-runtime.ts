/** Host-owned dispatch pump using public DSH Agents, Jobs and Session durability. */
import { createHash, randomUUID } from 'node:crypto';
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { JobRegistry, JobOutcome } from '@deepseek-ai/dsh-jobs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { GovernanceAccess, GovernanceDenied } from './governance-access.ts';
import type { WatchdogInstance, WatchdogScheduleStore } from './watchdog-schedule-store.ts';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'watchdog-dispatch': 'watchdog-dispatch'; }
}

/** Public runtime services; the product owns neither model loops nor job registries. */
export interface WatchdogScheduleServices {
  agents: Pick<AgentRegistry, 'get' | 'roots' | 'withoutInitiator'>;
  sessions: Pick<SessionStore, 'flush'>;
  jobs: Pick<JobRegistry, 'start' | 'attachController'>;
}

async function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([operation, stopped]); }
  finally { signal.removeEventListener('abort', abort!); }
}

/** One disposable worker; multiple workers coordinate through the same SQLite ledger. */
export class WatchdogScheduleRuntime {
  readonly workerId = randomUUID();
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<JobOutcome>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detachController: (() => void) | undefined;
  private disposal: Promise<void> | undefined;

  constructor(private readonly services: WatchdogScheduleServices, private readonly store: WatchdogScheduleStore, private readonly access: GovernanceAccess) {}

  /** Start only inside the explicitly loaded Host; no operating-system service is created. */
  start(): void {
    if (this.detachController) return;
    this.detachController = this.services.jobs.attachController('clawmaster-watchdog-schedules');
    this.wake();
  }

  private wake(): void {
    if (this.stop.signal.aborted) return;
    try { this.services.agents.withoutInitiator(() => this.tick()); }
    catch { // A failed database tick must not silently erase its last observed heartbeat.
      try { this.store.heartbeat(this.workerId, Date.now(), 'schedule_tick_failed'); }
      catch { /* A locked or unavailable database leaves a stale heartbeat for independent readers. */ }
    }
    this.timer = setTimeout(() => this.wake(), this.store.config.pollMs);
    this.timer.unref();
  }

  /** Sample wall time, recover expired leases, materialize bounded work, and start controlled jobs. */
  tick(now = Date.now()): void {
    this.stop.signal.throwIfAborted();
    this.store.heartbeat(this.workerId, now);
    this.store.materialize(now);
    for (let index = 0; index < this.store.config.maxConcurrent; index++) {
      const instance = this.store.claim(this.workerId, now);
      if (!instance) break;
      const plan = this.store.plan(instance.planId);
      const agent = this.services.agents.get(SessionId(plan.sessionId));
      if (!agent || !this.services.agents.roots().includes(agent)) {
        this.store.settle(instance, now, 'retry', 'bound_root_agent_offline');
        continue;
      }
      try {
        this.services.jobs.start({ kind: 'watchdog-dispatch', label: `WatchDog dispatch ${instance.id}`, owner: agent,
          run: () => {
            const cancelled = new AbortController();
            const timeout = AbortSignal.timeout(this.store.config.leaseMs);
            const signal = AbortSignal.any([this.stop.signal, cancelled.signal, timeout]);
            const done = this.dispatch(instance, agent, signal);
            this.pending.add(done);
            void done.then(() => this.pending.delete(done), () => this.pending.delete(done));
            return { done, cancel: () => cancelled.abort(new Error('Schedule dispatch cancelled.')) };
          } });
      } catch {
        this.store.settle(instance, Date.now(), 'retry', 'jobs_unavailable');
      }
    }
  }

  private async dispatch(instance: WatchdogInstance, agent: Agent, signal: AbortSignal): Promise<JobOutcome> {
    try {
      const plan = this.store.plan(instance.planId);
      const caller = await interruptible(this.access.agent(plan.sessionId, undefined, signal), signal);
      const checked = await interruptible(caller.check('task.write', plan.id), signal);
      if (checked.organizationId !== this.store.organizationId || (this.access.mode === 'enterprise' && checked.principalId !== plan.creator.principalId)) {
        throw new GovernanceDenied('The scheduled Session owner differs from the plan creator.');
      }
      if (!await interruptible(this.services.sessions.flush(agent.session), signal)) throw new Error('Session durability unavailable.');
      signal.throwIfAborted();
      if (this.services.agents.get(agent.id) !== agent || !this.services.agents.roots().includes(agent)) throw new Error('Bound root was unloaded.');
      const message = createUserMessage({ source: { kind: 'plugin', plugin: 'clawmaster-watchdog-schedules' }, content: [{ type: 'text',
        text: `WatchDog scheduled occurrence ${instance.id} at ${new Date(instance.scheduledAt).toISOString()}. This grant authorizes this prompt only; all tool approvals still apply. Dispatch does not certify business completion.\n${JSON.stringify({ task: plan.prompt })}` }] });
      let maintenance: Promise<void>;
      try {
        // The public DSH call synchronously rejects admission when a turn or maintenance owns the agent.
        maintenance = agent.runMaintenance(async maintenanceSignal => {
          const combined = AbortSignal.any([signal, maintenanceSignal]);
          // Permission can change while the persistence barrier or idle claim is pending.
          await interruptible(caller.check('task.write', plan.id), combined);
          combined.throwIfAborted();
          if (this.access.mode === 'enterprise' && !this.store.beginApproval(instance, Date.now())) throw new Error('Approval lease was withdrawn.');
          const authorized = this.access.mode === 'enterprise'
            ? await interruptible(caller.approve('task.write', plan.id, instance.id, 0, 0,
              createHash('sha256').update(JSON.stringify({ planId: plan.id, instanceId: instance.id, scheduledAt: instance.scheduledAt, prompt: plan.prompt })).digest('hex')), combined)
            : checked;
          const current = await interruptible(caller.check('task.write', plan.id), combined);
          combined.throwIfAborted();
          if (this.services.agents.get(agent.id) !== agent || !this.store.beginDispatch(instance, Date.now(), { ...current, ...(authorized.approval ? { approval: authorized.approval } : {}) })) throw new Error('Dispatch lease was withdrawn.');
          agent.followup(message);
          if (!await interruptible(this.services.sessions.flush(agent.session), combined)) throw new Error('Inbox durability unavailable.');
        });
      } catch {
        this.store.deferBusy(instance, Date.now());
        return { status: 'completed', detail: 'Dispatch deferred while the Session is busy; no input was delivered.' };
      }
      await maintenance;
      this.store.settle(instance, Date.now(), 'dispatched', 'inbox_persisted');
      return { status: 'completed', detail: 'Scheduled prompt persisted; business result requires separate review.' };
    } catch (error) {
      const denied = error instanceof GovernanceDenied;
      this.store.settle(instance, Date.now(), denied ? 'failed' : 'retry', denied ? 'permission_denied' : signal.aborted ? 'dispatch_cancelled_or_timed_out' : 'dispatch_unavailable');
      return { status: signal.aborted ? 'killed' : 'failed', detail: denied ? 'Permission denied.' : 'Dispatch did not confirm durable acceptance.' };
    }
  }

  /** Cancel and drain dispatch producers before their ledger closes; queued model turns are not cancelled. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.stop.abort(new Error('Schedule worker unloaded.'));
      if (this.timer) clearTimeout(this.timer);
      await Promise.allSettled(this.pending);
      this.detachController?.();
      this.store.heartbeat(this.workerId, Date.now(), 'worker_stopped');
    })();
  }
}
