/** Durable business work is independent of DSH Session execution state. */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { assertCommandReceipt, recordCommandReceipt } from './command-receipts.ts';
import { z } from 'zod';
import { EnterpriseError } from './enterprise-types.ts';
import { appendResponsibility, type ExecutionIdentity } from './governance-audit.ts';
import { taskRequestSchema, taskRecordSchema, taskListCursorSchema, type TaskRequest, type TaskRecord, type TaskStatus, type TaskListPage, type TaskHistoryPage } from './watchdog-task-format.ts';
export { taskRequestSchema, taskRecordSchema, taskIndicators } from './watchdog-task-format.ts';
export type { TaskRequest, TaskRecord, TaskStatus } from './watchdog-task-format.ts';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Per-response byte budget shared by HTTP and DSH tool consumers. */
export interface WatchdogTaskConfig { maxResponseBytes?: number; }
const limitsSchema = z.object({ maxResponseBytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER).default(65536) }).strict();

/** Validate the deployment budget before opening storage or publishing task consumers. */
export function resolveWatchdogTaskConfig(config: WatchdogTaskConfig = {}): Required<WatchdogTaskConfig> {
  return limitsSchema.parse(config);
}

// Node 22.19 exposes iterate; the repository's Node 22.10 declarations omit it.
interface IterableStatement extends StatementSync {
  iterate(...parameters: Array<string | number>): IterableIterator<unknown>;
}

/** Exact successful DSH output bytes include both the structured value and rendered text. */
export function taskResponseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }));
}

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
  ) STRICT;
  CREATE TABLE IF NOT EXISTS watchdog_task_versions (
    organizationId TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=0)
  ) STRICT;
  INSERT OR IGNORE INTO watchdog_task_versions(organizationId,version)
    SELECT DISTINCT organizationId,1 FROM watchdog_tasks;`);
}

const rowSchema = z.object({ body: z.string() }).passthrough();
/** Business-state failures remain distinct from CRM validation failures. */
export class TaskError extends Error {
  readonly code: 'permission_denied' | 'invalid_transition' | 'response_too_large';
  constructor(code: 'permission_denied' | 'invalid_transition' | 'response_too_large', message: string) { super(message); this.code = code; }
}
const human = (identity: ExecutionIdentity): void => {
  if (identity.actor.kind !== 'local-human' && identity.actor.kind !== 'member') {
    throw new TaskError('permission_denied', 'Only an authenticated human may review, reopen or cancel a task.');
  }
};

/** Scoped task owner; all callers use the same revision and transition checks. */
export class WatchdogTaskStore {
  private readonly db: DatabaseSync;
  readonly maxResponseBytes: number;
  constructor(db: DatabaseSync, config: WatchdogTaskConfig = {}) {
    this.db = db;
    this.maxResponseBytes = resolveWatchdogTaskConfig(config).maxResponseBytes;
  }

  private bounded<T>(value: T): T {
    if (taskResponseBytes(value) > this.maxResponseBytes) throw new TaskError('response_too_large',
      'Task response exceeds the configured byte budget. Shorten task text or ask an administrator to increase the budget.');
    return value;
  }

  private readRecord(row: unknown): TaskRecord {
    const body = rowSchema.parse(row).body;
    if (Buffer.byteLength(body) > this.maxResponseBytes) throw new TaskError('response_too_large',
      'Stored task exceeds the configured byte budget. Ask an administrator to increase the budget before reading it.');
    return this.bounded(taskRecordSchema.parse(JSON.parse(body)));
  }

  /** Read only the authenticated organization's record. */
  get(identity: ExecutionIdentity, taskId: string): TaskRecord {
    const row = this.db.prepare('SELECT body FROM watchdog_tasks WHERE organizationId=? AND id=?').get(identity.organizationId, taskId);
    if (!row) throw new EnterpriseError('not_found', 'Business task was not found.');
    return this.readRecord(row);
  }

  /** Page complete records by business urgency; the byte budget may shorten a page before its row limit. */
  list(identity: ExecutionIdentity, value: unknown = {}): TaskListPage {
    const query = z.object({ cursor: taskListCursorSchema.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict().parse(value);
    // One read transaction binds the collection version to every row, including another process's writes.
    this.db.exec('BEGIN');
    try {
      const version = this.collectionVersion(identity.organizationId);
      if (query.cursor && query.cursor.version !== version) throw new EnterpriseError('revision_conflict', 'Task list changed. Refresh before continuing.');
      const asOf = query.cursor?.asOf ?? new Date().toISOString();
      const offset = query.cursor?.offset ?? 0;
      const cursor = (position: number) => ({ version, offset: position, asOf });
      const statement = this.db.prepare(`SELECT body FROM watchdog_tasks WHERE organizationId=?
        ORDER BY CASE
        WHEN json_extract(body,'$.status')='awaiting_review' THEN 0
        WHEN json_extract(body,'$.status')='failed' THEN 1
        WHEN json_extract(body,'$.status') NOT IN ('accepted','cancelled') AND julianday(json_extract(body,'$.dueAt'))<julianday(?) THEN 2
        ELSE 3 END, json_extract(body,'$.updatedAt') DESC,id LIMIT ? OFFSET ?`) as IterableStatement;
      const tasks: TaskRecord[] = [];
      for (const row of statement.iterate(identity.organizationId, asOf, query.limit + 1, offset)) {
        const nextCursor = cursor(offset + tasks.length);
        if (tasks.length === query.limit) return this.bounded({ tasks, nextCursor });
        let task: TaskRecord;
        try {
          task = this.readRecord(row);
          this.bounded({ tasks: [...tasks, task], nextCursor: cursor(offset + tasks.length + 1) });
        } catch (error) {
          if (error instanceof TaskError && error.code === 'response_too_large' && tasks.length > 0) return this.bounded({ tasks, nextCursor });
          throw error;
        }
        tasks.push(task);
      }
      return this.bounded({ tasks, nextCursor: null });
    } finally { this.db.exec('ROLLBACK'); }
  }

  private collectionVersion(organizationId: string): number {
    const row = this.db.prepare('SELECT version FROM watchdog_task_versions WHERE organizationId=?').get(organizationId);
    return row ? z.object({ version: revision }).parse(row).version : 0;
  }

  /** Preserve each submission, review and prior evidence while returning a bounded history page. */
  history(identity: ExecutionIdentity, taskId: string, after = 0, limit = 50): TaskHistoryPage {
    const query = z.object({ after: revision, limit: z.number().int().min(1).max(100) }).parse({ after, limit });
    if (!this.db.prepare('SELECT id FROM watchdog_tasks WHERE organizationId=? AND id=?').get(identity.organizationId, taskId)) {
      throw new EnterpriseError('not_found', 'Business task was not found.');
    }
    const statement = this.db.prepare('SELECT body FROM watchdog_task_history WHERE organizationId=? AND taskId=? AND revision>? ORDER BY revision LIMIT ?') as IterableStatement;
    const tasks: TaskRecord[] = [];
    for (const row of statement.iterate(identity.organizationId, taskId, query.after, query.limit + 1)) {
      const nextAfter = tasks.at(-1)?.revision ?? query.after;
      if (tasks.length === query.limit) return this.bounded({ tasks, nextAfter });
      let task: TaskRecord;
      try {
        task = this.readRecord(row);
        this.bounded({ tasks: [...tasks, task], nextAfter: task.revision });
      } catch (error) {
        if (error instanceof TaskError && error.code === 'response_too_large' && tasks.length > 0) return this.bounded({ tasks, nextAfter });
        throw error;
      }
      tasks.push(task);
    }
    return this.bounded({ tasks, nextAfter: null });
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
    assertCommandReceipt(this.db, 'tasks', identity, request.commandId, request);
    const receipt = z.object({ actorId: z.string(), requestJson: z.string(), body: z.string() }).parse(row);
    if (receipt.actorId !== identity.actor.id || receipt.requestJson !== JSON.stringify(request)) {
      throw new EnterpriseError('command_conflict', 'Task command identifier was already used.');
    }
    return this.readRecord(receipt);
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
      const version = this.collectionVersion(identity.organizationId) + 1;
      if (!Number.isSafeInteger(version)) throw new EnterpriseError('numeric_overflow', 'Task list version is exhausted.');
      this.bounded({ tasks: [next], nextCursor: { version: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER, asOf: at } });
      this.bounded({ tasks: [next], nextAfter: Number.MAX_SAFE_INTEGER });
      recordCommandReceipt(this.db, 'tasks', identity, request.commandId, request);
      const body = JSON.stringify(next);
      this.db.prepare(`INSERT INTO watchdog_tasks(organizationId,id,revision,body) VALUES (?,?,?,?)
        ON CONFLICT(organizationId,id) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
        .run(identity.organizationId, request.id, next.revision, body);
      this.db.prepare('INSERT INTO watchdog_task_history(organizationId,taskId,revision,commandId,actorId,requestJson,body) VALUES (?,?,?,?,?,?,?)')
        .run(identity.organizationId, request.id, next.revision, request.commandId, identity.actor.id, JSON.stringify(request), body);
      this.db.prepare(`INSERT INTO watchdog_task_versions(organizationId,version) VALUES (?,?)
        ON CONFLICT(organizationId) DO UPDATE SET version=excluded.version`).run(identity.organizationId, version);
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
