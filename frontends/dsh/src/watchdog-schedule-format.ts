/** Validated wire inputs and bounded deployment settings for durable WatchDog dispatch. */
import { z } from 'zod';
import type { Branded } from '@deepseek-ai/dsh-brand';

/** Product plan identity; distinct from the Session-owned DSH Schedule identity. */
export type WatchdogPlanId = Branded<'WatchdogPlanId'>;
/** Stable identity of one plan occurrence. */
export type WatchdogInstanceId = Branded<'WatchdogInstanceId'>;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const planId = id.transform(value => value as WatchdogPlanId);
const instanceId = id.transform(value => value as WatchdogInstanceId);
const localAt = z.object({ date: z.string(), time: z.string(), time_zone: z.string() }).strict();
const rule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), everySeconds: z.number().int().min(300).max(31_536_000) }).strict(),
  z.object({ kind: z.literal('at'), at: z.union([z.string().max(100), localAt]) }).strict(),
]);
const reason = z.string().trim().min(1).max(1000);

/** Human or tool command; identity and approval cannot be supplied in its JSON. */
export const scheduleCommandSchema = z.object({ commandId: id, command: z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), id: planId, sessionId: id, prompt: z.string().trim().min(1).max(8000), rule,
    missed: z.enum(['skip', 'coalesce', 'catch-up']), catchUpLimit: z.number().int().min(1).max(100) }).strict(),
  z.object({ type: z.literal('cancel-plan'), id: planId, reason }).strict(),
  z.object({ type: z.literal('approve'), id: planId, instanceId }).strict(),
  z.object({ type: z.literal('cancel-instance'), id: planId, instanceId, reason }).strict(),
  z.object({ type: z.literal('resolve-uncertain'), id: planId, instanceId,
    resolution: z.enum(['acknowledge-dispatched', 'cancel']), reason }).strict(),
]) }).strict();
/** Parsed command fields, with opaque identifiers. */
export type ScheduleCommand = z.output<typeof scheduleCommandSchema>;

/** Deployment configuration. No mode installs a service or wakes a cold Session. */
export const watchdogScheduleConfigSchema = z.object({
  mode: z.enum(['desktop', 'server']).default('desktop'),
  busyTimeoutMs: z.number().int().min(0).max(60_000).default(5000),
  pollMs: z.number().int().min(100).max(60_000).default(1000),
  leaseMs: z.number().int().min(1000).max(300_000).default(30_000),
  heartbeatStaleMs: z.number().int().min(1000).max(600_000).default(15_000),
  maxPlans: z.number().int().min(1).max(10_000).default(1000),
  maxMaterializePlans: z.number().int().min(1).max(1000).default(64),
  maxPendingPerPlan: z.number().int().min(1).max(100).default(10),
  maxQueryBytes: z.number().int().min(1024).max(16_777_216).default(262144),
  maxConcurrent: z.number().int().min(1).max(100).default(2),
  maxDispatchesPerWindow: z.number().int().min(1).max(10_000).default(10),
  budgetWindowMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
  approvalTimeoutMs: z.number().int().min(1000).max(604_800_000).default(3_600_000),
  retryBaseMs: z.number().int().min(100).max(60_000).default(1000),
  retryMaxMs: z.number().int().min(100).max(3_600_000).default(60_000),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  onTimeGraceMs: z.number().int().min(0).max(300_000).default(5000),
}).strict().refine(value => value.heartbeatStaleMs > value.pollMs && value.leaseMs > value.pollMs && value.retryMaxMs >= value.retryBaseMs,
  'Heartbeat and lease intervals must exceed the poll interval; retry maximum must cover the base delay.');
/** Optional deployment inputs; defaults are resolved once when opening the store. */
export type WatchdogScheduleConfig = z.input<typeof watchdogScheduleConfigSchema>;
/** Resolved deployment limits persisted as a shared database configuration fingerprint. */
export type ResolvedScheduleConfig = Readonly<z.output<typeof watchdogScheduleConfigSchema>>;

/** Exact UTF-8 bytes sent as HTTP JSON or successful DSH string value plus rendered text.
 * @param value - JSON-compatible result before serialization.
 * @param transport - Carrier whose complete result is measured.
 * @returns Serialized response bytes, including repeated strings and JSON escaping.
 */
export function scheduleResponseBytes(value: unknown, transport: 'http' | 'tool'): number {
  const text = JSON.stringify(value);
  return new TextEncoder().encode(transport === 'http' ? text : JSON.stringify({ isError: false, value: text, content: [{ type: 'text', text }] })).byteLength;
}

/** Failure code safe to expose without internal paths or provider errors. */
export class WatchdogScheduleError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
