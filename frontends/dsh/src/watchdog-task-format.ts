/** Browser-safe validation and presentation data for durable WatchDog business tasks. */
import { z } from 'zod';

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

/** Validate durable task rows and the same fields received by the browser. */
export const taskRecordSchema = z.object({ ...taskFields, id, organizationId: id, revision: revision.min(1),
  status: z.enum(['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), source: z.enum(['new', 'imported-session']),
  sessionIds: z.array(id), waitingFor: text.nullable(), evidence: z.array(evidence), completedCriteria: z.array(id),
  submittedBy: id.nullable(), lastReview: z.object({ actorId: id, decision: z.enum(['accept', 'reject']), comment: text, at: z.string().datetime() }).strict().nullable(),
}).strict();

/** List cursors count records; history cursors identify the last returned immutable revision. */
export const taskQuerySchema = z.object({ id: id.optional(), offset: revision.default(0), after: revision.default(0),
  limit: z.number().int().min(1).max(100).default(50), history: z.boolean().default(false) }).strict()
  .refine(query => query.history ? query.id !== undefined && query.offset === 0 : query.after === 0,
    { message: 'History requires an id and uses after rather than offset.' });

/** Pages always expose continuation when additional complete records remain. */
export const taskListSchema = z.object({ tasks: z.array(taskRecordSchema), nextOffset: revision.nullable() }).strict();
export const taskHistorySchema = z.object({ tasks: z.array(taskRecordSchema), nextAfter: revision.nullable() }).strict();
export const taskQueryResultSchema = z.union([taskRecordSchema, taskListSchema, taskHistorySchema]);
export type TaskListPage = z.infer<typeof taskListSchema>;
export type TaskHistoryPage = z.infer<typeof taskHistorySchema>;

/** Task indicators never use Session.running as evidence of completion. */
export function taskIndicators(task: TaskRecord, now = Date.now()) {
  return { overdue: task.dueAt !== null && Date.parse(task.dueAt) < now && task.status !== 'accepted' && task.status !== 'cancelled',
    waiting: task.waitingFor !== null, evidenceAvailability: 'unchecked' as const };
}
