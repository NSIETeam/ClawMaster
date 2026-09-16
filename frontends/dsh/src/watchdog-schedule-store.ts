/** SQLite occurrence ledger; DSH Schedule owns rule validation and fixed-rate arithmetic. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { createAtScheduleRecord, createEveryScheduleRecord, decodeScheduleChange, resolveEveryOccurrence, ScheduleId } from '@deepseek-ai/dsh-schedule';
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import type { ExecutionIdentity } from './governance-audit.ts';
import { scheduleCommandSchema, scheduleResponseBytes, watchdogScheduleConfigSchema, WatchdogScheduleError } from './watchdog-schedule-format.ts';
import type { ResolvedScheduleConfig, ScheduleCommand, WatchdogInstanceId, WatchdogPlanId, WatchdogScheduleConfig } from './watchdog-schedule-format.ts';

const APPLICATION_ID = 0x434d5343;
const integer = z.number().int().nonnegative();
const instanceSchema = z.object({ id: z.string().transform(value => value as WatchdogInstanceId), planId: z.string().transform(value => value as WatchdogPlanId),
  scheduledAt: integer, createdAt: integer, expiresAt: integer, state: z.enum(['waiting_approval', 'ready', 'leased', 'dispatching', 'dispatched', 'uncertain', 'failed', 'cancelled']),
  attempts: integer, nextAttemptAt: integer, fence: integer, leaseOwner: z.string().nullable(), leaseUntil: integer.nullable(),
  reason: z.string().nullable(), approvedBy: z.string().nullable(), finishedAt: integer.nullable() });
const planRow = z.object({ id: z.string(), definition: z.string(), creator: z.string(), active: integer, nextAt: integer.nullable(), missedCount: integer });
const sqliteRow = z.record(z.string(), z.unknown());
const countRow = z.object({ n: integer });
const creatorSchema = z.object({ organizationId: z.string(), principalId: z.string().optional(), actor: z.object({ kind: z.string(), id: z.string().optional() }) }).passthrough();

/** One immutable plan definition and its persisted cursor. */
export interface WatchdogPlan {
  id: WatchdogPlanId;
  sessionId: string;
  prompt: string;
  record: ScheduleRecord;
  missed: 'skip' | 'coalesce' | 'catch-up';
  catchUpLimit: number;
  creator: z.output<typeof creatorSchema>;
  active: boolean;
  nextAt: number | null;
  missedCount: number;
}
/** A durable dispatch attempt; dispatched means inbox durability, never business acceptance. */
export type WatchdogInstance = z.output<typeof instanceSchema>;

function fail(code: string, message: string): never { throw new WatchdogScheduleError(code, message); }
function parsePlan(value: unknown): WatchdogPlan {
  const row = planRow.parse(value);
  const definition = z.object({ command: scheduleCommandSchema.shape.command, record: z.unknown() }).parse(JSON.parse(row.definition));
  const change = decodeScheduleChange({ version: 1, operation: 'create', schedule: definition.record });
  if (definition.command.type !== 'create' || change.operation !== 'create') return fail('invalid_storage', 'Invalid stored schedule definition.');
  return { ...definition.command, record: change.schedule, creator: creatorSchema.parse(JSON.parse(row.creator)),
    active: Boolean(row.active), nextAt: row.nextAt, missedCount: row.missedCount };
}
function stableInstanceId(id: WatchdogPlanId, at: number): WatchdogInstanceId {
  return createHash('sha256').update(`${id}:${at}`).digest('hex') as WatchdogInstanceId;
}

/** Independent durable owner; all multi-process claims and state changes are serialized by SQLite. */
export class WatchdogScheduleStore {
  constructor(private readonly db: DatabaseSync, readonly organizationId: string, readonly config: ResolvedScheduleConfig) {}

  /** Close this connection after its runtime and HTTP consumers have drained. */
  close(): void { this.db.close(); }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private observe<T>(action: () => T): T {
    this.db.exec('BEGIN');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private audit(at: number, planId: WatchdogPlanId, instanceId: WatchdogInstanceId | null, action: string, actor: string, reason: string | null): void {
    this.db.prepare('INSERT INTO schedule_audit(at,planId,instanceId,action,actor,reason) VALUES(?,?,?,?,?,?)').run(at, planId, instanceId, action, actor, reason);
  }
  private requireOrganization(identity: ExecutionIdentity): void {
    if (identity.organizationId !== this.organizationId) fail('permission_denied', 'Schedule organization mismatch.');
  }

  /** Read one plan, including its immutable owner and next future occurrence. */
  plan(id: WatchdogPlanId): WatchdogPlan {
    const row = this.db.prepare('SELECT * FROM schedule_plans WHERE id=?').get(id);
    if (!row) return fail('not_found', 'Schedule plan was not found.');
    return parsePlan(row);
  }

  /** Read one instance or fail without inventing a new occurrence. */
  instance(id: WatchdogInstanceId): WatchdogInstance {
    const row = this.db.prepare('SELECT * FROM schedule_instances WHERE id=?').get(id);
    if (!row) return fail('not_found', 'Schedule instance was not found.');
    return instanceSchema.parse(row);
  }

  /** Execute a caller-authorized command exactly once, retaining its actor and result. */
  command(identity: ExecutionIdentity, request: ScheduleCommand, now: number, transport: 'http' | 'tool' = 'http'): unknown {
    this.requireOrganization(identity);
    const serialized = JSON.stringify(request);
    const actor = JSON.stringify({ actor: identity.actor, principalId: identity.principalId, organizationId: identity.organizationId });
    return this.transaction(() => {
      const replay = this.db.prepare('SELECT request,actor,result FROM schedule_commands WHERE id=?').get(request.commandId);
      if (replay) {
        const receipt = sqliteRow.parse(replay);
        if (receipt.request !== serialized || receipt.actor !== actor) fail('command_conflict', 'Schedule command identity was already used.');
        const result = { ...sqliteRow.parse(JSON.parse(String(receipt.result))), commandId: request.commandId };
        if (scheduleResponseBytes(result, transport) > this.config.maxQueryBytes) fail('response_too_large', 'Schedule command receipt exceeds the response budget.');
        return result;
      }
      const command = request.command;
      if (command.type === 'create') {
        const total = countRow.parse(this.db.prepare('SELECT COUNT(*) AS n FROM schedule_plans').get()).n;
        if (total >= this.config.maxPlans) fail('capacity_exceeded', 'Schedule plan capacity reached.');
        if (this.db.prepare('SELECT id FROM schedule_plans WHERE id=?').get(command.id)) fail('already_exists', 'Schedule plan identity cannot be reused.');
        const record = command.rule.kind === 'every'
          ? createEveryScheduleRecord(ScheduleId(command.id), command.prompt, command.rule.everySeconds, now)
          : createAtScheduleRecord(ScheduleId(command.id), command.prompt, command.rule.at, now);
        this.db.prepare('INSERT INTO schedule_plans(id,definition,creator,active,nextAt,missedCount) VALUES(?,?,?,1,?,0)')
          .run(command.id, JSON.stringify({ command, record }), JSON.stringify(identity), Date.parse(record.scheduledAt));
      } else if (command.type === 'cancel-plan') {
        this.plan(command.id);
        this.db.prepare('UPDATE schedule_plans SET active=0 WHERE id=?').run(command.id);
      } else {
        const instance = this.instance(command.instanceId);
        if (instance.planId !== command.id) fail('permission_denied', 'Occurrence belongs to another plan.');
        if (command.type === 'approve') {
          if (instance.state !== 'waiting_approval' || now >= instance.expiresAt) fail('state_conflict', 'This occurrence cannot be approved.');
          this.db.prepare("UPDATE schedule_instances SET state='ready',approvedBy=? WHERE id=?").run(JSON.stringify(identity), instance.id);
        } else if (command.type === 'cancel-instance') {
          if (!['waiting_approval', 'ready', 'leased'].includes(instance.state)) fail('state_conflict', 'A dispatch already attempted cannot be cancelled retroactively.');
          this.db.prepare("UPDATE schedule_instances SET state='cancelled',fence=fence+1,leaseOwner=NULL,leaseUntil=NULL,reason=?,finishedAt=? WHERE id=?")
            .run(command.reason, now, instance.id);
        } else {
          if (identity.actor.kind !== 'local-human' && identity.actor.kind !== 'member') fail('permission_denied', 'Only a human may resolve uncertain dispatch.');
          if (instance.state !== 'uncertain') fail('state_conflict', 'This occurrence is not uncertain.');
          this.db.prepare('UPDATE schedule_instances SET state=?,reason=?,finishedAt=? WHERE id=?')
            .run(command.resolution === 'cancel' ? 'cancelled' : 'dispatched', command.reason, now, instance.id);
        }
      }
      this.audit(now, command.id, 'instanceId' in command ? command.instanceId : null, command.type, JSON.stringify(identity), 'reason' in command ? command.reason : null);
      const result = { ...('instanceId' in command ? this.instance(command.instanceId) : this.plan(command.id)), commandId: request.commandId };
      if (scheduleResponseBytes(result, transport) > this.config.maxQueryBytes) fail('response_too_large', 'Schedule command receipt exceeds the response budget.');
      this.db.prepare('INSERT INTO schedule_commands(id,request,actor,result) VALUES(?,?,?,?)').run(request.commandId, serialized, actor, JSON.stringify(result));
      return result;
    });
  }

  /** Materialize a bounded number of due occurrences and advance each fixed-rate cursor in O(1). */
  materialize(now: number): void {
    this.transaction(() => {
      const plans = this.db.prepare('SELECT * FROM schedule_plans WHERE active=1 AND nextAt<=? ORDER BY nextAt,id LIMIT ?')
        .all(now, this.config.maxMaterializePlans).map(parsePlan);
      for (const plan of plans) {
        const first = plan.nextAt!;
        const interval = plan.record.kind === 'every' ? plan.record.everySeconds * 1000 : 0;
        const occurrence = plan.record.kind === 'every' ? resolveEveryOccurrence({ ...plan.record, scheduledAt: new Date(first).toISOString() }, now) : undefined;
        const latest = occurrence ? Date.parse(occurrence.occurrenceAt) : first;
        const total = interval ? Math.floor((latest - first) / interval) + 1 : 1;
        const pending = countRow.parse(this.db.prepare("SELECT COUNT(*) AS n FROM schedule_instances WHERE planId=? AND state IN ('waiting_approval','ready','leased','dispatching')").get(plan.id)).n;
        const desired = plan.missed === 'skip' ? Number(now - latest <= this.config.onTimeGraceMs)
          : plan.missed === 'coalesce' ? 1 : Math.min(total, plan.catchUpLimit);
        const count = Math.max(0, Math.min(desired, this.config.maxPendingPerPlan - pending));
        for (let index = count - 1; index >= 0; index--) {
          const at = latest - index * interval;
          const id = stableInstanceId(plan.id, at);
          this.db.prepare(`INSERT INTO schedule_instances(id,planId,scheduledAt,createdAt,expiresAt,state,attempts,nextAttemptAt,fence)
            VALUES(?,?,?,?,?,'waiting_approval',0,?,0)`).run(id, plan.id, at, now, now + this.config.approvalTimeoutMs, now);
          this.audit(now, plan.id, id, 'materialized', 'scheduler', null);
        }
        this.db.prepare('UPDATE schedule_plans SET nextAt=?,active=?,missedCount=missedCount+? WHERE id=?')
          .run(occurrence?.nextScheduledAt ? Date.parse(occurrence.nextScheduledAt) : null, occurrence?.nextScheduledAt ? 1 : 0, total - count, plan.id);
      }
    });
  }

  private recover(now: number): void {
    const rows = this.db.prepare(`SELECT * FROM schedule_instances WHERE
      (state IN ('leased','dispatching') AND leaseUntil<=?) OR (state IN ('waiting_approval','ready') AND expiresAt<=?) LIMIT ?`).all(now, now, this.config.maxMaterializePlans).map(value => instanceSchema.parse(value));
    for (const instance of rows) {
      const uncertain = instance.state === 'dispatching';
      const retry = instance.state === 'leased' && instance.attempts < this.config.maxAttempts && now < instance.expiresAt;
      const state = uncertain ? 'uncertain' : retry ? 'ready' : 'failed';
      const reason = uncertain ? 'worker_lost_after_dispatch_barrier' : retry ? 'lease_expired_before_dispatch'
        : instance.state === 'waiting_approval' ? 'approval_timeout' : 'execution_deadline_or_attempts_exhausted';
      this.db.prepare('UPDATE schedule_instances SET state=?,reason=?,leaseOwner=NULL,leaseUntil=NULL,fence=fence+1,nextAttemptAt=?,finishedAt=? WHERE id=?')
        .run(state, reason, now + this.backoff(instance.attempts), retry ? null : now, instance.id);
      this.audit(now, instance.planId, instance.id, state, 'scheduler', reason);
    }
  }

  /** Claim one approved occurrence, enforcing database-wide admission and active lease limits. */
  claim(workerId: string, now: number): WatchdogInstance | undefined {
    return this.transaction(() => {
      this.recover(now);
      const active = countRow.parse(this.db.prepare("SELECT COUNT(*) AS n FROM schedule_instances WHERE state IN ('leased','dispatching')").get()).n;
      if (active >= this.config.maxConcurrent) return undefined;
      const dispatched = countRow.parse(this.db.prepare("SELECT COUNT(*) AS n FROM schedule_audit WHERE action='dispatching' AND at>?").get(now - this.config.budgetWindowMs)).n;
      if (dispatched + active >= this.config.maxDispatchesPerWindow) return undefined;
      const value = this.db.prepare("SELECT * FROM schedule_instances WHERE state='ready' AND nextAttemptAt<=? AND expiresAt>? ORDER BY scheduledAt,id LIMIT 1").get(now, now);
      if (!value) return undefined;
      const instance = instanceSchema.parse(value);
      this.db.prepare("UPDATE schedule_instances SET state='leased',attempts=attempts+1,fence=fence+1,leaseOwner=?,leaseUntil=? WHERE id=?")
        .run(workerId, now + this.config.leaseMs, instance.id);
      return this.instance(instance.id);
    });
  }

  private backoff(attempts: number): number { return Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** Math.max(0, attempts - 1)); }
  private owns(instance: WatchdogInstance, now: number, state: string): boolean {
    const current = this.instance(instance.id);
    return current.state === state && current.leaseOwner === instance.leaseOwner && current.fence === instance.fence && current.leaseUntil! > now;
  }

  /** Commit the non-replay barrier immediately before enqueue; stale owners cannot enter it. */
  beginDispatch(instance: WatchdogInstance, now: number, identity?: ExecutionIdentity): boolean {
    return this.transaction(() => {
      if (!this.owns(instance, now, 'leased') || instance.expiresAt <= now) return false;
      if (identity) {
        this.requireOrganization(identity);
        this.audit(now, instance.planId, instance.id, 'dispatch-authorized', JSON.stringify({ ...identity, source: 'scheduler' }), null);
      }
      this.db.prepare("UPDATE schedule_instances SET state='dispatching' WHERE id=?").run(instance.id);
      this.audit(now, instance.planId, instance.id, 'dispatching', instance.leaseOwner!, null);
      return true;
    });
  }

  /** Settle a live lease; any failure after the barrier requires human resolution and is never retried. */
  settle(instance: WatchdogInstance, now: number, outcome: 'dispatched' | 'retry' | 'failed', reason: string): void {
    this.transaction(() => {
      const current = this.instance(instance.id);
      if (current.fence !== instance.fence || current.leaseOwner !== instance.leaseOwner) return;
      if (!['leased', 'dispatching'].includes(current.state)) return;
      const afterBarrier = current.state === 'dispatching';
      const state = outcome === 'dispatched' && afterBarrier ? 'dispatched' : afterBarrier ? 'uncertain'
        : outcome === 'retry' && current.attempts < this.config.maxAttempts && now < current.expiresAt ? 'ready' : 'failed';
      this.db.prepare('UPDATE schedule_instances SET state=?,reason=?,nextAttemptAt=?,leaseOwner=NULL,leaseUntil=NULL,finishedAt=? WHERE id=?')
        .run(state, reason, now + this.backoff(current.attempts), state === 'ready' ? null : now, instance.id);
      this.audit(now, instance.planId, instance.id, state, instance.leaseOwner!, reason);
    });
  }

  /** Persist liveness independently of any agent and recover expired leases even with no ready work. */
  heartbeat(workerId: string, now: number, error: string | null = null): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO schedule_workers(id,mode,lastHeartbeat,error) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET lastHeartbeat=excluded.lastHeartbeat,error=excluded.error')
        .run(workerId, this.config.mode, now, error);
      this.recover(now);
    });
  }

  /** Read complete record and worker pages without modifying state; cursors identify the last included row.
   * @param identity - Trusted organization-scoped reader.
   * @param now - Wall-clock sample used consistently for heartbeat and lease observations.
   * @param planId - Select this plan's occurrences; omission lists plans.
   * @param after - Last record cursor, or zero for the first page.
   * @param limit - Maximum complete records to return, from one to one hundred.
   * @param fits - Check the full carrier response, including its final cursors and worker summary.
   * @param workersAfter - Independent last-worker cursor, or zero for its first page.
   * @returns A byte-bounded page or an explicit error when the first whole record and worker cannot fit.
   */
  query(identity: ExecutionIdentity, now: number, planId?: WatchdogPlanId, after = 0, limit = 50,
    fits: (value: unknown) => boolean = value => scheduleResponseBytes(value, 'http') <= this.config.maxQueryBytes, workersAfter = 0): unknown {
    this.requireOrganization(identity);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(workersAfter) || workersAfter < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_request', 'Schedule pages require nonnegative cursors and 1 <= limit <= 100.');
    return this.observe(() => {
      const cutoff = now - this.config.heartbeatStaleMs;
      const summary = sqliteRow.parse(this.db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(error IS NULL AND lastHeartbeat>=?),0) AS online,
        COALESCE(SUM(error IS NOT NULL AND error!='worker_stopped' AND lastHeartbeat>=?),0) AS degraded,
        COALESCE(SUM((error IS NULL OR error!='worker_stopped') AND lastHeartbeat<?),0) AS offline,
        COALESCE(SUM(error='worker_stopped'),0) AS stopped FROM schedule_workers`).get(cutoff, cutoff, cutoff));
      const workers = this.db.prepare('SELECT rowid AS cursor,* FROM schedule_workers WHERE rowid>? ORDER BY rowid LIMIT 101').all(workersAfter).map(value => {
        const { cursor, ...row } = sqliteRow.parse(value);
        const stale = now - Number(row.lastHeartbeat) > this.config.heartbeatStaleMs;
        return { cursor: Number(cursor), value: { ...row, stale, status: row.error === 'worker_stopped' ? 'stopped' : stale ? 'offline' : row.error ? 'degraded' : 'online' } };
      });
      const rows = (planId ? this.db.prepare('SELECT rowid AS cursor,* FROM schedule_instances WHERE planId=? AND rowid>? ORDER BY rowid LIMIT ?').all(planId, after, limit + 1)
        : this.db.prepare('SELECT rowid AS cursor,* FROM schedule_plans WHERE rowid>? ORDER BY rowid LIMIT ?').all(after, limit + 1)).map(value => sqliteRow.parse(value));
      const records = rows.map(row => planId ? { ...instanceSchema.parse(row), leaseExpired: row.leaseUntil !== null && Number(row.leaseUntil) <= now } : parsePlan(row));
      const response = (recordCount: number, workerCount: number) => ({ mode: this.config.mode,
        workers: workers.slice(0, workerCount).map(worker => worker.value),
        workerSummary: { ...summary, nextAfter: workers.length > workerCount ? workers[workerCount - 1]!.cursor : null },
        records: records.slice(0, recordCount), nextAfter: rows.length > recordCount ? Number(rows[recordCount - 1]!.cursor) : null });
      let recordCount = Math.min(1, records.length);
      let workerCount = Math.min(1, workers.length);
      if (!fits(response(recordCount, workerCount))) fail('response_too_large', 'One complete schedule record with its worker observation exceeds the response budget.');
      while (recordCount < Math.min(limit, records.length) && fits(response(recordCount + 1, workerCount))) recordCount++;
      while (workerCount < Math.min(100, workers.length) && fits(response(recordCount, workerCount + 1))) workerCount++;
      return response(recordCount, workerCount);
    });
  }

  /** Read immutable scheduling decisions, grants, retries and human resolutions with a stable cursor. */
  history(identity: ExecutionIdentity, planId: WatchdogPlanId, after = 0, limit = 50,
    fits: (value: unknown) => boolean = value => scheduleResponseBytes(value, 'http') <= this.config.maxQueryBytes): unknown {
    this.requireOrganization(identity);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_request', 'Invalid schedule history page.');
    const rows = this.db.prepare('SELECT * FROM schedule_audit WHERE planId=? AND seq>? ORDER BY seq LIMIT ?').all(planId, after, limit + 1).map(value => sqliteRow.parse(value));
    const response = (count: number) => ({ records: rows.slice(0, count), nextAfter: rows.length > count ? Number(rows[count - 1]!.seq) : null });
    let count = Math.min(1, rows.length);
    if (!fits(response(count))) fail('response_too_large', 'One complete schedule history entry exceeds the response budget.');
    while (count < Math.min(limit, rows.length) && fits(response(count + 1))) count++;
    return response(count);
  }
}

/** Open a private organization-bound ledger; unsupported schemas and divergent worker limits fail closed.
 * @param path - Absolute path owned by this deployment.
 * @param organizationId - Trusted organization binding; never inferred from command JSON.
 * @param options - Deployment limits, resolved and matched against the stored configuration.
 * @returns The open owner; close it after consumers and workers drain.
 */
export async function openWatchdogScheduleStore(path: string, organizationId: string, options: WatchdogScheduleConfig = {}): Promise<WatchdogScheduleStore> {
  if (!isAbsolute(path)) fail('invalid_configuration', 'Schedule database path must be absolute.');
  const config = Object.freeze(watchdogScheduleConfigSchema.parse(options));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600); await handle.close();
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=${config.busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE`);
    const application = Number(sqliteRow.parse(db.prepare('PRAGMA application_id').get()).application_id);
    const version = Number(sqliteRow.parse(db.prepare('PRAGMA user_version').get()).user_version);
    if (application !== 0 && application !== APPLICATION_ID || version > 1 || version > 0 && application !== APPLICATION_ID) fail('invalid_storage', 'Unsupported schedule database.');
    if (!version) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length) fail('invalid_storage', 'Schedule database already contains unrelated tables.');
      db.exec(`CREATE TABLE schedule_meta(organizationId TEXT NOT NULL,config TEXT NOT NULL);
        CREATE TABLE schedule_plans(id TEXT PRIMARY KEY,definition TEXT NOT NULL,creator TEXT NOT NULL,active INTEGER NOT NULL,nextAt INTEGER,missedCount INTEGER NOT NULL);
        CREATE TABLE schedule_instances(id TEXT PRIMARY KEY,planId TEXT NOT NULL REFERENCES schedule_plans(id),scheduledAt INTEGER NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,state TEXT NOT NULL,
          attempts INTEGER NOT NULL,nextAttemptAt INTEGER NOT NULL,fence INTEGER NOT NULL,leaseOwner TEXT,leaseUntil INTEGER,reason TEXT,approvedBy TEXT,finishedAt INTEGER,UNIQUE(planId,scheduledAt));
        CREATE INDEX schedule_due ON schedule_plans(active,nextAt);
        CREATE INDEX schedule_claim ON schedule_instances(state,nextAttemptAt);
        CREATE TABLE schedule_commands(id TEXT PRIMARY KEY,request TEXT NOT NULL,actor TEXT NOT NULL,result TEXT NOT NULL);
        CREATE TABLE schedule_workers(id TEXT PRIMARY KEY,mode TEXT NOT NULL,lastHeartbeat INTEGER NOT NULL,error TEXT);
        CREATE TABLE schedule_audit(seq INTEGER PRIMARY KEY,at INTEGER NOT NULL,planId TEXT NOT NULL,instanceId TEXT,action TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT);
        CREATE TRIGGER schedule_audit_no_update BEFORE UPDATE ON schedule_audit BEGIN SELECT RAISE(ABORT,'Schedule history is append-only'); END;
        CREATE TRIGGER schedule_audit_no_delete BEFORE DELETE ON schedule_audit BEGIN SELECT RAISE(ABORT,'Schedule history is append-only'); END;
        CREATE INDEX schedule_audit_plan ON schedule_audit(planId,seq);
        CREATE INDEX schedule_audit_budget ON schedule_audit(action,at);
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
      db.prepare('INSERT INTO schedule_meta(organizationId,config) VALUES(?,?)').run(organizationId, JSON.stringify(config));
    }
    const meta = sqliteRow.parse(db.prepare('SELECT * FROM schedule_meta').get());
    if (meta?.organizationId !== organizationId || meta?.config !== JSON.stringify(config)) fail('invalid_configuration', 'Schedule organization or deployment limits differ from the stored configuration.');
    db.exec('COMMIT');
    return new WatchdogScheduleStore(db, organizationId, config);
  } catch (error) { db.close(); throw error; }
}
