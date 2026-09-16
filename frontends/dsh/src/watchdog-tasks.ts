/** Durable business work is independent of DSH Session execution state. */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { EnterpriseError } from './enterprise-types.ts';
import { appendResponsibility, type ExecutionIdentity } from './governance-audit.ts';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().trim().min(1).max(4000);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const owner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), label: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('member'), id }).strict(),
]);
const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
const criterion = z.object({ id, description: text }).strict();
const evidence = z.object({ id, location: z.string().min(1).max(2000), observedAt: z.string().datetime(), summary: text }).strict();
const taskFields = {
  goal: text, scope: text, owner, dueAt: z.string().datetime().nullable(), timezone,
  risk: z.enum(['low', 'medium', 'high']), checklist: z.array(criterion).min(1).max(100),
};
const definition = z.object(taskFields).strict().refine(task => new Set(task.checklist.map(row => row.id)).size === task.checklist.length);
const command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), task: definition, importedSessionId: id.optional() }).strict(),
  z.object({ type: z.literal('revise'), task: definition }).strict(),
  z.object({ type: z.literal('queue') }).strict(),
  z.object({ type: z.literal('start'), sessionId: id }).strict(),
  z.object({ type: z.literal('link'), sessionId: id }).strict(),
  z.object({ type: z.literal('wait'), reason: text.nullable() }).strict(),
  z.object({ type: z.literal('fail'), reason: text }).strict(),
  z.object({ type: z.literal('submit'), evidence: z.array(evidence).min(1).max(100), completedCriteria: z.array(id).min(1).max(100) }).strict(),
  z.object({ type: z.literal('review'), decision: z.enum(['accept', 'reject']), comment: text }).strict(),
  z.object({ type: z.literal('reopen'), reason: text }).strict(),
  z.object({ type: z.literal('cancel'), reason: text }).strict(),
]);

/** Wire validation rejects caller-supplied actor, organization, approval and accepted-state fields. */
export const taskRequestSchema = z.object({ id, commandId: id, revision, command }).strict();
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type TaskStatus = 'draft' | 'ready' | 'in_progress' | 'awaiting_review' | 'accepted' | 'failed' | 'cancelled';
export interface TaskRecord extends z.infer<typeof definition> {
  id: string;
  organizationId: string;
  revision: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  source: 'new' | 'imported-session';
  sessionIds: string[];
  waitingFor: string | null;
  evidence: Array<z.infer<typeof evidence>>;
  completedCriteria: string[];
  submittedBy: string | null;
  lastReview: { actorId: string; decision: 'accept' | 'reject'; comment: string; at: string } | null;
}

/** Validate durable task rows and expose the same fields to tool output validation. */
export const taskRecordSchema = z.object({ ...taskFields, id, organizationId: id, revision: revision.min(1),
  status: z.enum(['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), source: z.enum(['new', 'imported-session']),
  sessionIds: z.array(id), waitingFor: text.nullable(), evidence: z.array(evidence), completedCriteria: z.array(id),
  submittedBy: id.nullable(), lastReview: z.object({ actorId: id, decision: z.enum(['accept', 'reject']), comment: text, at: z.string().datetime() }).strict().nullable(),
}).strict();

/** Tables are excluded from CRM/ERP restore, so business acceptance cannot roll back with inventory. */
export function initializeTasks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS watchdog_tasks (
    organizationId TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
    PRIMARY KEY(organizationId,id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS watchdog_task_history (
    organizationId TEXT NOT NULL, taskId TEXT NOT NULL, revision INTEGER NOT NULL, commandId TEXT NOT NULL,
    actorId TEXT NOT NULL, requestJson TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
    PRIMARY KEY(organizationId,taskId,revision), UNIQUE(organizationId,commandId)
  ) STRICT;`);
}

const rowSchema = z.object({ body: z.string() }).passthrough();
/** Business-state failures remain distinct from CRM validation failures. */
export class TaskError extends Error {
  readonly code: 'permission_denied' | 'invalid_transition';
  constructor(code: 'permission_denied' | 'invalid_transition', message: string) { super(message); this.code = code; }
}
const human = (identity: ExecutionIdentity): void => {
  if (identity.actor.kind !== 'local-human' && identity.actor.kind !== 'member') {
    throw new TaskError('permission_denied', 'Only an authenticated human may review, reopen or cancel a task.');
  }
};

/** Server-derived task indicators never use Session.running as evidence of completion. */
export function taskIndicators(task: TaskRecord, now = Date.now()) {
  return { overdue: task.dueAt !== null && Date.parse(task.dueAt) < now && task.status !== 'accepted' && task.status !== 'cancelled',
    waiting: task.waitingFor !== null, evidenceAvailability: 'unchecked' as const };
}

/** Scoped task owner; all callers use the same revision and transition checks. */
export class WatchdogTaskStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  /** Read only the authenticated organization's record. */
  get(identity: ExecutionIdentity, taskId: string): TaskRecord {
    const row = this.db.prepare('SELECT body FROM watchdog_tasks WHERE organizationId=? AND id=?').get(identity.organizationId, taskId);
    if (!row) throw new EnterpriseError('not_found', 'Business task was not found.');
    return taskRecordSchema.parse(JSON.parse(rowSchema.parse(row).body));
  }

  /** Page business records without inferring historical completion from idle Sessions. */
  list(identity: ExecutionIdentity, value: unknown = {}) {
    const query = z.object({ offset: revision.default(0), limit: z.number().int().min(1).max(100).default(50),
      status: z.enum(['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled']).optional() }).strict().parse(value);
    const rows = this.db.prepare(`SELECT body FROM watchdog_tasks WHERE organizationId=?
      ${query.status ? "AND json_extract(body,'$.status')=?" : ''} ORDER BY json_extract(body,'$.updatedAt') DESC,id LIMIT ? OFFSET ?`)
      .all(identity.organizationId, ...(query.status ? [query.status] : []), query.limit + 1, query.offset);
    const tasks = rows.slice(0, query.limit).map(value => taskRecordSchema.parse(JSON.parse(rowSchema.parse(value).body)));
    return { tasks, nextOffset: rows.length > query.limit ? query.offset + tasks.length : null };
  }

  /** Preserve each submission, review and prior evidence while returning a bounded history page. */
  history(identity: ExecutionIdentity, taskId: string, after = 0) {
    this.get(identity, taskId);
    return this.db.prepare('SELECT body FROM watchdog_task_history WHERE organizationId=? AND taskId=? AND revision>? ORDER BY revision LIMIT 100')
      .all(identity.organizationId, taskId, after).map(value => taskRecordSchema.parse(JSON.parse(rowSchema.parse(value).body)));
  }

  /**
   * Return an exact committed command's result; conflicting reuse fails.
   * @param identity Caller whose current resource authorization was checked by the consumer.
   * @param value Command envelope to match against the persisted receipt.
   * @returns The original task revision, or undefined when the command has not committed.
   */
  replay(identity: ExecutionIdentity, value: unknown): TaskRecord | undefined {
    const request = taskRequestSchema.parse(value);
    if (identity.actor.kind === 'unknown') throw new TaskError('permission_denied', 'Task commands require a known caller.');
    const row = this.db.prepare('SELECT actorId, requestJson, body FROM watchdog_task_history WHERE organizationId=? AND commandId=?')
      .get(identity.organizationId, request.commandId);
    if (!row) return undefined;
    const receipt = z.object({ actorId: z.string(), requestJson: z.string(), body: z.string() }).parse(row);
    if (receipt.actorId !== identity.actor.id || receipt.requestJson !== JSON.stringify(request)) {
      throw new EnterpriseError('command_conflict', 'Task command identifier was already used.');
    }
    return taskRecordSchema.parse(JSON.parse(receipt.body));
  }

  /** Commit one state transition and its responsibility record atomically; exact retries return the original result. */
  execute(identity: ExecutionIdentity, value: unknown): TaskRecord {
    const request = taskRequestSchema.parse(value);
    if (identity.actor.kind === 'unknown') throw new TaskError('permission_denied', 'Task commands require a known caller.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.replay(identity, request);
      if (replay) {
        this.db.exec('COMMIT');
        return replay;
      }
      const at = new Date().toISOString();
      let next: TaskRecord;
      if (request.command.type === 'create') {
        if (request.revision !== 0) throw new EnterpriseError('revision_conflict', 'New tasks start at revision zero.');
        if (this.db.prepare('SELECT id FROM watchdog_tasks WHERE organizationId=? AND id=?').get(identity.organizationId, request.id)) {
          throw new EnterpriseError('command_conflict', 'Task identifier already exists.');
        }
        next = { ...request.command.task, id: request.id, organizationId: identity.organizationId, revision: 1,
          status: 'draft', createdAt: at, updatedAt: at, source: request.command.importedSessionId ? 'imported-session' : 'new',
          sessionIds: request.command.importedSessionId ? [request.command.importedSessionId] : [], waitingFor: null,
          evidence: [], completedCriteria: [], submittedBy: null, lastReview: null };
      } else {
        const previous = this.get(identity, request.id);
        if (request.revision !== previous.revision) throw new EnterpriseError('revision_conflict', 'Task changed. Reload before saving.', previous.revision);
        if (!Number.isSafeInteger(previous.revision + 1)) throw new EnterpriseError('numeric_overflow', 'Task revision is exhausted.');
        next = this.transition(identity, previous, request.command, at);
        next.revision++;
        next.updatedAt = at;
      }
      if (identity.organizationId !== 'local' && next.owner.kind !== 'member') {
        throw new EnterpriseError('invalid_request', 'Organization tasks require a member identifier as owner.');
      }
      const body = JSON.stringify(next);
      this.db.prepare(`INSERT INTO watchdog_tasks(organizationId,id,revision,body) VALUES (?,?,?,?)
        ON CONFLICT(organizationId,id) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
        .run(identity.organizationId, request.id, next.revision, body);
      this.db.prepare('INSERT INTO watchdog_task_history(organizationId,taskId,revision,commandId,actorId,requestJson,body) VALUES (?,?,?,?,?,?,?)')
        .run(identity.organizationId, request.id, next.revision, request.commandId, identity.actor.id, JSON.stringify(request), body);
      appendResponsibility(this.db, { identity, operation: `task.${request.command.type}`, outcome: 'succeeded', commandId: request.commandId, entityId: request.id,
        generationBefore: 0, generationAfter: 0, revisionBefore: request.revision, revisionAfter: next.revision });
      this.db.exec('COMMIT');
      return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private transition(identity: ExecutionIdentity, task: TaskRecord, action: Exclude<TaskRequest['command'], { type: 'create' }>, at: string): TaskRecord {
    const next = structuredClone(task);
    const requireState = (...states: TaskStatus[]) => {
      if (!states.includes(task.status)) throw new TaskError('invalid_transition', `Cannot ${action.type} a task in ${task.status}.`);
    };
    switch (action.type) {
      case 'revise': requireState('draft', 'ready'); Object.assign(next, action.task); break;
      case 'queue': requireState('draft', 'failed'); next.status = 'ready'; next.waitingFor = null; break;
      case 'start':
        requireState('ready'); next.status = 'in_progress'; next.waitingFor = null;
        next.sessionIds = [...new Set([...next.sessionIds, action.sessionId])]; break;
      case 'link': next.sessionIds = [...new Set([...next.sessionIds, action.sessionId])]; break;
      case 'wait': requireState('ready', 'in_progress'); next.waitingFor = action.reason; break;
      case 'fail': requireState('ready', 'in_progress'); next.status = 'failed'; next.waitingFor = action.reason; break;
      case 'submit': {
        requireState('in_progress');
        const completed = new Set(action.completedCriteria);
        if (completed.size !== task.checklist.length || !task.checklist.every(item => completed.has(item.id))) {
          throw new EnterpriseError('invalid_request', 'Submission must address every acceptance criterion.');
        }
        if (new Set(action.evidence.map(item => item.id)).size !== action.evidence.length) throw new EnterpriseError('invalid_request', 'Evidence identifiers must be unique.');
        next.evidence = action.evidence; next.completedCriteria = action.completedCriteria; next.submittedBy = identity.principalId ?? identity.actor.id;
        next.status = 'awaiting_review'; next.waitingFor = null; break;
      }
      case 'review':
        human(identity); requireState('awaiting_review');
        if (identity.organizationId !== 'local' && task.submittedBy === identity.actor.id) {
          throw new TaskError('permission_denied', 'The result submitter cannot approve their own task.');
        }
        next.status = action.decision === 'accept' ? 'accepted' : 'ready';
        next.lastReview = { actorId: identity.actor.id, decision: action.decision, comment: action.comment, at }; break;
      case 'reopen':
        human(identity); requireState('accepted', 'cancelled'); next.status = 'ready'; next.waitingFor = action.reason; break;
      case 'cancel': human(identity); requireState('draft', 'ready', 'in_progress', 'awaiting_review', 'failed'); next.status = 'cancelled'; next.waitingFor = action.reason; break;
    }
    return next;
  }
}
