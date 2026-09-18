/** Browser-safe validation and presentation data for durable WatchDog business tasks. */
import { z } from 'zod';
import { stateCapsuleDataSchema, stateCapsuleScopeSchema, stateCapsulesSchema } from './watchdog-state-capsule.ts';
import { trustedAuthorityIdentifierSchema } from './governance-identity.ts';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const authorityId = trustedAuthorityIdentifierSchema;
const text = z.string().trim().min(1).max(4000);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const owner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), label: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('member'), id: authorityId }).strict(),
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
  z.object({ type: z.literal('start'), sessionId: id, requestId: id, locale: z.enum(['zh-CN', 'en-US']).default('en-US') }).strict(),
  z.object({ type: z.literal('link'), sessionId: id }).strict(),
  z.object({ type: z.literal('wait'), reason: text.nullable() }).strict(),
  z.object({ type: z.literal('fail'), reason: text }).strict(),
  z.object({ type: z.literal('submit'), evidence: z.array(evidence).min(1).max(100), completedCriteria: z.array(id).min(1).max(100) }).strict(),
  z.object({ type: z.literal('capsule'), scope: stateCapsuleScopeSchema, data: stateCapsuleDataSchema }).strict(),
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
  execution: { sessionId: string; requestId: string; locale: 'zh-CN' | 'en-US'; commandId?: string } | null;
  waitingFor: string | null;
  evidence: Array<z.infer<typeof evidence>>;
  /** Read-time evidence status; absent from durable rows and mutation requests. */
  evidenceAvailability?: 'available' | 'unavailable' | 'unchecked';
  stateCapsules: z.infer<typeof stateCapsulesSchema>;
  completedCriteria: string[];
  submittedBy: string | null;
  lastReview: { actorId: string; decision: 'accept' | 'reject'; comment: string; at: string } | null;
}

/** Validate durable task rows and the same fields received by the browser. */
export const taskRecordSchema = z.object({ ...taskFields, id, organizationId: authorityId, revision: revision.min(1),
  status: z.enum(['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), source: z.enum(['new', 'imported-session']),
  sessionIds: z.array(id), execution: z.object({ sessionId: id, requestId: id, locale: z.enum(['zh-CN', 'en-US']).default('en-US'), commandId: id.optional() }).strict().nullable().default(null),
  waitingFor: text.nullable(), evidence: z.array(evidence), evidenceAvailability: z.enum(['available', 'unavailable', 'unchecked']).optional(),
  stateCapsules: stateCapsulesSchema.default([]), completedCriteria: z.array(id),
  submittedBy: authorityId.nullable(), lastReview: z.object({ actorId: authorityId, decision: z.enum(['accept', 'reject']), comment: text, at: z.string().datetime() }).strict().nullable(),
}).strict();

/** A list retains its collection version and urgency clock across pages. */
export const taskListCursorSchema = z.object({ version: revision, offset: revision.min(1), asOf: z.string().datetime() }).strict();
export type TaskListCursor = z.infer<typeof taskListCursorSchema>;
/** History cursors identify the last returned immutable revision. */
export const taskQuerySchema = z.object({ id: id.optional(), cursor: taskListCursorSchema.optional(), after: revision.default(0),
  limit: z.number().int().min(1).max(100).default(50), history: z.boolean().default(false) }).strict()
  .refine(query => (!query.id || !query.cursor) && (query.history ? query.id !== undefined : query.after === 0),
    { message: 'History requires an id and uses after; list cursors cannot select an id.' });

/** Pages always expose continuation when additional complete records remain. */
export const taskListSchema = z.object({ tasks: z.array(taskRecordSchema), nextCursor: taskListCursorSchema.nullable() }).strict();
export const taskHistorySchema = z.object({ tasks: z.array(taskRecordSchema), nextAfter: revision.nullable() }).strict();
/** A Session dispatch receipt is bound to the persisted task start and cannot assert caller identity. */
export const taskExecutionOutcomeSchema = z.object({ taskId: id, requestId: id, sessionId: id,
  outcome: z.enum(['uncertain', 'succeeded', 'failed']), reasonCode: z.enum([
    'session_rejected', 'session_turn_error', 'session_turn_blocked', 'session_turn_aborted', 'session_turn_interrupted', 'session_max_tokens',
  ]).optional() }).strict();
export const taskExecutionOutcomeResultSchema = z.object({ outcome: z.enum(['uncertain', 'succeeded', 'failed']) }).strict();
export const taskQueryResultSchema = z.union([taskRecordSchema, taskListSchema, taskHistorySchema]);
export type TaskListPage = z.infer<typeof taskListSchema>;
export type TaskHistoryPage = z.infer<typeof taskHistorySchema>;

/** Task indicators never use Session.running as evidence of completion. */
export function taskIndicators(task: TaskRecord, now = Date.now()) {
  return { overdue: task.dueAt !== null && Date.parse(task.dueAt) < now && task.status !== 'accepted' && task.status !== 'cancelled',
    waiting: task.waitingFor !== null && (task.status === 'ready' || task.status === 'in_progress'), evidenceAvailability: task.evidenceAvailability ?? 'unchecked' };
}

/** Counts durable task signals for the WatchDog home result view. */
export interface TaskAttentionSummary {
  total: number;
  needsAttention: number;
  overdue: number;
  waiting: number;
  awaitingReview: number;
  failed: number;
}

/** Aggregate durable task signals for the WatchDog home result view. Counts are page-scoped when the caller has loaded a bounded page.
 * @param tasks - The bounded page of durable tasks currently available to the caller.
 * @param now - Clock used to classify deadlines, supplied by tests or the browser.
 * @returns Counts where needsAttention counts each task at most once.
 */
export function taskAttentionSummary(tasks: readonly TaskRecord[], now = Date.now()): TaskAttentionSummary {
  let overdue = 0;
  let waiting = 0;
  let awaitingReview = 0;
  let failed = 0;
  let needsAttention = 0;
  for (const task of tasks) {
    const indicators = taskIndicators(task, now);
    if (indicators.overdue) overdue += 1;
    if (indicators.waiting) waiting += 1;
    if (task.status === 'awaiting_review') awaitingReview += 1;
    if (task.status === 'failed') failed += 1;
    if (indicators.overdue || indicators.waiting || task.status === 'awaiting_review' || task.status === 'failed') needsAttention += 1;
  }
  return { total: tasks.length, needsAttention, overdue, waiting, awaitingReview, failed };
}
