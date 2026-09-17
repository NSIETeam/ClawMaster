/** Responsibility records survive business backup restores; local hashes detect accidental edits, not a hostile machine owner. */
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { EnterpriseError } from './enterprise-types.ts';
import { trustedAuthorityIdentifierSchema } from './governance-identity.ts';

const sqliteRow = z.record(z.string(), z.unknown());
interface IterableStatement extends StatementSync { iterate(...parameters: Array<string | number>): IterableIterator<unknown>; }

/** Host-resolved caller facts; local device labels do not identify enterprise members. */
export type ExecutionApproval = { kind: 'authority'; id: string; approverId: string; generation: number; revision: number }
  | { kind: 'dsh-one-shot' };

export interface ExecutionIdentity {
  actor: { kind: 'local-human' | 'member' | 'agent' | 'unknown'; id: string };
  organizationId: string;
  source: 'http' | 'tool' | 'scheduler' | 'plugin' | 'migration';
  policyVersion: number;
  /** Authenticated initiating member when an agent acts on their behalf. */
  principalId?: string;
  sessionId?: string;
  callId?: string;
  approval?: ExecutionApproval;
}

/** Local desktop identity names the authenticated device operator, not an organization member. */
export const LOCAL_HTTP_IDENTITY: ExecutionIdentity = Object.freeze({
  actor: Object.freeze({ kind: 'local-human', id: 'local-operator' }),
  organizationId: 'local', source: 'http', policyVersion: 1,
});

/** Direct maintenance calls without an authenticated carrier retain an unknown actor. */
export const UNKNOWN_IDENTITY: ExecutionIdentity = Object.freeze({
  actor: Object.freeze({ kind: 'unknown', id: 'unknown' }),
  organizationId: 'local', source: 'plugin', policyVersion: 0,
});

/** Only identifiers, operation metadata and digests enter responsibility history. */
export interface ResponsibilityInput {
  identity: ExecutionIdentity;
  operation: string;
  outcome: 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'uncertain' | 'legacy';
  commandId?: string;
  entityId?: string;
  generationBefore: number;
  revisionBefore: number;
  generationAfter: number;
  revisionAfter: number;
  backupSha256?: string;
  taskExecution?: { requestId: string; sessionId: string };
  reasonCode?: string;
}

/** A hash links the exact persisted JSON to its predecessor. */
type UnlabelledLegacyApproval = { id: string; approverId: string; generation: number; revision: number; kind?: undefined };

/** Older stored rows may contain unlabelled approval fields; they are not trusted approval evidence. */
export type ResponsibilityIdentity = Omit<ExecutionIdentity, 'approval'> & { approval?: ExecutionApproval | UnlabelledLegacyApproval };

export interface ResponsibilityRecord extends Omit<ResponsibilityInput, 'identity'> {
  identity: ResponsibilityIdentity;
  sequence: number;
  at: string;
  previousHash: string;
  hash: string;
}

/** An uncertain task dispatch whose target Session log can still confirm an outcome. */
export interface PendingTaskExecutionOutcome { requestId: string; sessionId: string }

/** Install independent history and import old receipts once, with explicitly unknown actors. */
export function initializeResponsibilityHistory(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS responsibility_history (
    sequence INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), hash TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS restore_receipts (
    commandId TEXT PRIMARY KEY, requestHash TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS responsibility_no_update BEFORE UPDATE ON responsibility_history
    BEGIN SELECT RAISE(ABORT, 'Responsibility history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS responsibility_no_delete BEFORE DELETE ON responsibility_history
    BEGIN SELECT RAISE(ABORT, 'Responsibility history is append-only'); END;
  CREATE INDEX IF NOT EXISTS responsibility_execution_request ON responsibility_history(
    json_extract(body, '$.taskExecution.requestId'), sequence
  ) WHERE json_extract(body, '$.operation') = 'task.dispatch';`);
  if (db.prepare('SELECT sequence FROM responsibility_history LIMIT 1').get()) return;
  const meta = sqliteRow.parse(db.prepare('SELECT generation FROM enterprise_meta WHERE singleton=1').get());
  const generation = Number(meta.generation);
  for (const value of (db.prepare('SELECT revision, commandId, type, entityId FROM enterprise_audit ORDER BY revision') as IterableStatement).iterate()) {
    const row = sqliteRow.parse(value);
    appendResponsibility(db, { identity: { ...UNKNOWN_IDENTITY, source: 'migration' }, operation: String(row.type), outcome: 'legacy',
      commandId: String(row.commandId), entityId: String(row.entityId), generationBefore: generation, generationAfter: generation,
      revisionBefore: Number(row.revision) - 1, revisionAfter: Number(row.revision), reasonCode: 'legacy_actor_unknown' });
  }
}

/** Append inside the owning transaction so a successful mutation and its receipt commit together. */
export function appendResponsibility(db: DatabaseSync, input: ResponsibilityInput): ResponsibilityRecord {
  const previous = sqliteRow.optional().parse(db.prepare('SELECT sequence, hash FROM responsibility_history ORDER BY sequence DESC LIMIT 1').get());
  const body = { sequence: Number(previous?.sequence ?? 0) + 1, at: new Date().toISOString(), previousHash: String(previous?.hash ?? ''), ...input };
  const encoded = JSON.stringify(body);
  const hash = createHash('sha256').update(encoded).digest('hex');
  db.prepare('INSERT INTO responsibility_history(sequence, body, hash) VALUES (?, ?, ?)').run(body.sequence, encoded, hash);
  return { ...body, hash };
}

const taskExecutionOutcomeReportSchema = z.object({
  taskId: z.string().min(1).max(128), requestId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128),
  outcome: z.enum(['uncertain', 'succeeded', 'failed']), reasonCode: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'failed') !== (value.reasonCode !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Only failed task execution outcomes require a fixed reason code.' });
  }
});
const taskExecutionOutcomeSchema = taskExecutionOutcomeReportSchema.extend({
  taskRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), commandId: z.string().min(1).max(128),
}).strict();
const observedTaskExecutionOutcomeSchema = z.object({
  requestId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128),
  outcome: z.enum(['succeeded', 'failed']), reasonCode: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'failed') !== (value.reasonCode !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Failed Session outcomes require a fixed reason code.' });
  }
});
const executionIdentitySchema = z.object({
  actor: z.object({ kind: z.enum(['local-human', 'member', 'agent', 'unknown']), id: trustedAuthorityIdentifierSchema }).strict(),
  organizationId: trustedAuthorityIdentifierSchema, source: z.enum(['http', 'tool', 'scheduler', 'plugin', 'migration']),
  policyVersion: z.number().int(), principalId: trustedAuthorityIdentifierSchema.optional(), sessionId: trustedAuthorityIdentifierSchema.optional(), callId: trustedAuthorityIdentifierSchema.optional(),
  approval: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('authority'), id: trustedAuthorityIdentifierSchema, approverId: trustedAuthorityIdentifierSchema, generation: z.number().int(), revision: z.number().int() }).strict(),
    z.object({ kind: z.literal('dsh-one-shot') }).strict(),
  ]).optional(),
}).strict();
const persistedExecutionIdentitySchema = executionIdentitySchema.extend({
  approval: z.union([executionIdentitySchema.shape.approval.unwrap(), z.object({
    id: trustedAuthorityIdentifierSchema, approverId: trustedAuthorityIdentifierSchema, generation: z.number().int(), revision: z.number().int(), kind: z.undefined().optional(),
  }).strict()]).optional(),
});

/** Task Session outcome report; the Host resolves its command and revision from durable task history. */
export type TaskExecutionOutcomeReport = z.input<typeof taskExecutionOutcomeReportSchema>;
/** Audited task execution fields after the Host verifies the persisted start receipt. */
export type TaskExecutionOutcomeInput = z.input<typeof taskExecutionOutcomeSchema>;
/** Terminal task outcome emitted only after the Host observes the correlated Session turn. */
export type ObservedTaskExecutionOutcome = Omit<TaskExecutionOutcomeReport, 'taskId' | 'outcome'>
  & { outcome: 'succeeded' | 'failed' };

type TaskExecutionBinding = Pick<TaskExecutionOutcomeInput, 'commandId' | 'taskRevision'>;

/**
 * Append or resolve one persisted task Session submission without overwriting earlier outcomes.
 * @param db The enterprise database that owns responsibility history.
 * @param identity Host-resolved caller; request JSON cannot supply this identity.
 * @param value Task, DSH request, Session and observed outcome.
 * @param resolveBinding Resolve the task revision and start command from its durable receipt inside this transaction.
 * @returns The existing idempotent outcome or the newly appended outcome.
 * @throws EnterpriseError when the binding conflicts or an invalid outcome transition is requested.
 */
export function recordTaskExecutionOutcome(db: DatabaseSync, identity: ExecutionIdentity, value: TaskExecutionOutcomeReport,
  resolveBinding: () => TaskExecutionBinding): ResponsibilityRecord {
  const report = taskExecutionOutcomeReportSchema.parse(value);
  db.exec('BEGIN IMMEDIATE');
  try {
    const input = taskExecutionOutcomeSchema.parse({ ...report, ...resolveBinding() });
    const record = appendTaskExecutionOutcomeInTransaction(db, identity, input);
    db.exec('COMMIT');
    return record;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Append a terminal outcome using only the trusted identity already recorded for an admitted Session request. */
export function recordObservedTaskExecutionOutcome(db: DatabaseSync,
  value: ObservedTaskExecutionOutcome,
  resolveBinding: (identity: ExecutionIdentity, taskId: string) => TaskExecutionBinding): ResponsibilityRecord | undefined {
  const request = observedTaskExecutionOutcomeSchema.parse(value);
  db.exec('BEGIN IMMEDIATE');
  try {
    const matches = [...(db.prepare(`SELECT body FROM responsibility_history
      WHERE json_extract(body, '$.operation') = 'task.dispatch'
        AND json_extract(body, '$.outcome') = 'uncertain'
        AND json_extract(body, '$.taskExecution.requestId') = ?
        AND json_extract(body, '$.taskExecution.sessionId') = ? ORDER BY sequence`) as IterableStatement)
      .iterate(request.requestId, request.sessionId)];
    if (matches.length === 0) { db.exec('COMMIT'); return undefined; }
    if (matches.length !== 1) throw new EnterpriseError('command_conflict', 'Session request matches multiple task executions.');
    const row = sqliteRow.parse(matches[0]);
    const prior = z.object({ entityId: z.string().min(1), identity: persistedExecutionIdentitySchema }).passthrough()
      .parse(JSON.parse(String(row.body)));
    const { approval, ...identityFields } = prior.identity;
    const identity = executionIdentitySchema.parse({ ...identityFields,
      ...(approval && 'kind' in approval && approval.kind !== undefined && approval.kind !== null
        && (approval.kind === 'authority' || approval.kind === 'dsh-one-shot') ? { approval } : {}),
    });
    const input = taskExecutionOutcomeSchema.parse({ ...request, taskId: prior.entityId, ...resolveBinding(identity, prior.entityId) });
    const record = appendTaskExecutionOutcomeInTransaction(db, identity, input);
    db.exec('COMMIT');
    return record;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** List only the latest uncertain receipt for each Session request identity. */
export function listPendingTaskExecutionOutcomes(db: DatabaseSync): PendingTaskExecutionOutcome[] {
  const rows = db.prepare(`WITH latest AS (
    SELECT json_extract(body, '$.taskExecution.requestId') AS requestId,
      json_extract(body, '$.taskExecution.sessionId') AS sessionId, MAX(sequence) AS sequence
    FROM responsibility_history
    WHERE json_extract(body, '$.operation') = 'task.dispatch'
      AND json_extract(body, '$.taskExecution.requestId') IS NOT NULL
      AND json_extract(body, '$.taskExecution.sessionId') IS NOT NULL
    GROUP BY requestId, sessionId
  ) SELECT body FROM responsibility_history JOIN latest USING(sequence)
    WHERE json_extract(body, '$.outcome') = 'uncertain' ORDER BY sequence`) as IterableStatement;
  return [...rows.iterate()].map(value => {
    const record = z.object({ outcome: z.literal('uncertain'), taskExecution: z.object({
      requestId: z.string().min(1), sessionId: z.string().min(1),
    }).strict() }).passthrough().parse(JSON.parse(String(sqliteRow.parse(value).body)));
    return record.taskExecution;
  });
}

/** Append one task execution fact after the caller has established its binding in the active transaction. */
function appendTaskExecutionOutcomeInTransaction(db: DatabaseSync, identity: ExecutionIdentity,
  input: TaskExecutionOutcomeInput): ResponsibilityRecord {
  const matches = (db.prepare(`SELECT sequence, body, hash FROM responsibility_history
    WHERE json_extract(body, '$.operation') = 'task.dispatch'
      AND json_extract(body, '$.taskExecution.requestId') = ? ORDER BY sequence`) as IterableStatement).iterate(input.requestId);
  let previous: ResponsibilityRecord | undefined;
  for (const raw of matches) {
    const row = sqliteRow.parse(raw);
    const record = { ...JSON.parse(String(row.body)) as Omit<ResponsibilityRecord, 'hash'>, hash: String(row.hash) };
    const priorIdentity = record.identity;
    if (record.entityId !== input.taskId || record.commandId !== input.commandId
      || record.revisionBefore !== input.taskRevision || record.revisionAfter !== input.taskRevision
      || record.taskExecution?.sessionId !== input.sessionId || priorIdentity.organizationId !== identity.organizationId
      || priorIdentity.actor.kind !== identity.actor.kind || priorIdentity.actor.id !== identity.actor.id
      || priorIdentity.principalId !== identity.principalId) {
      throw new EnterpriseError('command_conflict', 'Task execution request identifier is bound to different responsibility metadata.');
    }
    previous = record;
  }
  if (previous) {
    if (input.outcome === 'uncertain' || previous.outcome === input.outcome) {
      if (previous.outcome === input.outcome && previous.reasonCode !== input.reasonCode) {
        throw new EnterpriseError('command_conflict', 'Task execution outcome was replayed with a different reason.');
      }
      return previous;
    }
    if (previous.outcome !== 'uncertain') throw new EnterpriseError('command_conflict', 'Task execution outcome is already final.');
  } else if (input.outcome !== 'uncertain') {
    throw new EnterpriseError('command_conflict', 'Task execution must be admitted as uncertain before it can finish.');
  }
  return appendResponsibility(db, { identity, operation: 'task.dispatch', outcome: input.outcome,
    commandId: input.commandId, entityId: input.taskId, generationBefore: 0, generationAfter: 0,
    revisionBefore: input.taskRevision, revisionAfter: input.taskRevision, taskExecution: { requestId: input.requestId, sessionId: input.sessionId },
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }) });
}

const querySchema = z.object({
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  actorId: z.string().max(128).optional(), commandId: z.string().max(128).optional(),
  entityId: z.string().max(128).optional(), operation: z.string().max(128).optional(),
}).strict();

/** Deployment-validated row and complete-response byte limits for responsibility reads. */
export interface ResponsibilityQueryLimits { maxRows: number; maxBytes: number; }

type ResponsibilityPage = { records: ResponsibilityRecord[]; nextAfter: number | null };

function responseBytes(value: ResponsibilityPage, transport: 'http' | 'tool'): number {
  const text = JSON.stringify(value);
  return Buffer.byteLength(transport === 'http' ? text : JSON.stringify({ isError: false, value, content: [{ type: 'text', text }] }), 'utf8');
}

/**
 * Read complete records within row and encoded-response budgets, continuing after the last returned sequence.
 * @param db Open responsibility database whose history is append-only.
 * @param value Optional metadata filters, exclusive after sequence and requested row limit.
 * @param limits Already validated deployment limits; omitted query limit uses maxRows.
 * @param transport HTTP JSON or DSH structured value with its JSON text rendering.
 * @returns One page; nextAfter is null when no further matching record was observed.
 * @throws EnterpriseError when the query is invalid or its first record or response metadata cannot fit.
 */
export function queryResponsibility(db: DatabaseSync, value: unknown, limits: ResponsibilityQueryLimits,
  transport: 'http' | 'tool' = 'http'): ResponsibilityPage {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) throw new EnterpriseError('invalid_request', 'Invalid responsibility history query.');
  const query = parsed.data;
  const limit = query.limit ?? limits.maxRows;
  if (limit > limits.maxRows) throw new EnterpriseError('invalid_request', 'Responsibility history row limit exceeds the configured maximum.');
  const predicates = ['sequence > ?'];
  const parameters: (string | number)[] = [query.after];
  for (const [key, path] of [['actorId', '$.identity.actor.id'], ['commandId', '$.commandId'], ['entityId', '$.entityId'], ['operation', '$.operation']] as const) {
    if (query[key] !== undefined) { predicates.push(`json_extract(body, '${path}') = ?`); parameters.push(query[key]); }
  }
  const rows = (db.prepare(`SELECT body, hash FROM responsibility_history WHERE ${predicates.join(' AND ')} ORDER BY sequence`) as IterableStatement).iterate(...parameters);
  const records: ResponsibilityRecord[] = [];
  let nextAfter: number | null = null;
  let recordBytes = 0;
  const emptyBytes = responseBytes({ records: [], nextAfter: null }, transport);
  try {
    let current = rows.next();
    while (!current.done && records.length < limit) {
      const row = sqliteRow.parse(current.value);
      const record = { ...JSON.parse(String(row.body)) as Omit<ResponsibilityRecord, 'hash'>, hash: String(row.hash) };
      const following = rows.next();
      const candidateAfter = following.done ? null : record.sequence;
      const candidateBytes = recordBytes + responseBytes({ records: [record], nextAfter: null }, transport) - emptyBytes
        + (records.length > 0 ? transport === 'http' ? 1 : 2 : 0);
      if (responseBytes({ records: [], nextAfter: candidateAfter }, transport) + candidateBytes > limits.maxBytes) {
        if (records.length === 0) throw new EnterpriseError('result_too_large', 'A responsibility record exceeds the configured response byte budget.');
        break;
      }
      records.push(record);
      recordBytes = candidateBytes;
      nextAfter = candidateAfter;
      current = following;
    }
  } finally { rows.return?.(); }
  const result = { records, nextAfter };
  if (responseBytes(result, transport) > limits.maxBytes) throw new EnterpriseError('result_too_large', 'Responsibility response metadata exceeds the configured byte budget.');
  return result;
}

/** Validate the complete hash chain without loading the business database into memory. */
export function verifyResponsibility(db: DatabaseSync): void {
  let sequence = 0;
  let previousHash = '';
  for (const value of (db.prepare('SELECT sequence, body, hash FROM responsibility_history ORDER BY sequence') as IterableStatement).iterate()) {
    const row = sqliteRow.parse(value);
    const body = JSON.parse(String(row.body)) as ResponsibilityRecord;
    if (Number(row.sequence) !== ++sequence || body.sequence !== sequence || body.previousHash !== previousHash
      || createHash('sha256').update(String(row.body)).digest('hex') !== row.hash) throw new Error('Responsibility history integrity check failed.');
    previousHash = String(row.hash);
  }
}
