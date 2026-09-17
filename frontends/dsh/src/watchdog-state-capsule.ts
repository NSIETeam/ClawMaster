/** Persisted, scope-isolated WatchDog task state carried by task revisions. */
import { z } from 'zod';
import { trustedAuthorityIdentifierSchema } from './governance-identity.ts';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const authorityId = trustedAuthorityIdentifierSchema;
const text = z.string().trim().min(1).max(4000);
const timestamp = z.string().datetime();

/** Scope selectors accepted by a capsule update; user identity is host-derived. */
export const stateCapsuleScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('project'), id }).strict(),
  z.object({ kind: z.literal('session'), id }).strict(),
]);

/** Facts that must survive task revisions and application restarts. */
export const stateCapsuleDataSchema = z.object({
  decisions: z.array(z.object({ id, decision: text, rationale: text, recordedAt: timestamp }).strict()).max(1000),
  fileHashes: z.array(z.object({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), observedAt: timestamp }).strict()).max(1000),
  verificationResults: z.array(z.object({ id, status: z.enum(['passed', 'failed', 'blocked', 'pending']), summary: text, verifiedAt: timestamp }).strict()).max(1000),
  unfinishedActions: z.array(z.object({ id, description: text, status: z.enum(['pending', 'in_progress', 'blocked']), ownerId: authorityId.optional() }).strict()).max(1000),
  memoryIds: z.array(id).max(1000),
}).strict();

/** One task-revision snapshot, keyed by scope. */
export const stateCapsuleRecordSchema = z.object({
  ownerId: authorityId,
  target: text,
  approvalState: z.object({
    status: z.enum(['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled']),
    lastReview: z.object({ actorId: authorityId, decision: z.enum(['accept', 'reject']), comment: text, at: timestamp }).strict().nullable(),
  }).strict(),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), id: authorityId }).strict(),
    z.object({ kind: z.literal('project'), id }).strict(),
    z.object({ kind: z.literal('session'), id }).strict(),
  ]),
  data: stateCapsuleDataSchema,
  updatedAt: timestamp,
}).strict();

/** Durable per-task collection; one record is retained for each owner and scope. */
export const stateCapsulesSchema = z.array(stateCapsuleRecordSchema).max(3000);
export type StateCapsuleScope = z.infer<typeof stateCapsuleScopeSchema>;
export type StateCapsuleData = z.infer<typeof stateCapsuleDataSchema>;
export type StateCapsuleRecord = z.infer<typeof stateCapsuleRecordSchema>;
