/** Authenticated schedule management and one-shot occurrence grants. */
import { z } from 'zod';
import { GovernanceCommandInput, CommandInputError } from './command-input.ts';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { ScheduleInputError } from '@deepseek-ai/dsh-schedule';
import type { EnterpriseHostContext, EnterpriseStore } from './enterprise-host.ts';
import type { EnterpriseToolContext } from './enterprise-tools.ts';
import { GovernanceAccess, GovernanceDenied, auditGovernanceOutcome } from './governance-access.ts';
import type { GovernanceCaller } from './governance-access.ts';
import { scheduleCommandSchema, scheduleResponseBytes, WatchdogScheduleError } from './watchdog-schedule-format.ts';
import type { ScheduleCommand, WatchdogPlanId } from './watchdog-schedule-format.ts';
import type { WatchdogScheduleStore } from './watchdog-schedule-store.ts';
import type { WatchdogScheduleServices } from './watchdog-schedule-runtime.ts';

const path = '/api/clawmaster/schedules';
const querySchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).transform(value => value as WatchdogPlanId).optional(),
  after: z.number().int().min(0).default(0), workersAfter: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), history: z.boolean().default(false) }).strict();
const queryParameters = { ...parameterSchemaSpecToJsonSchema({ id: { type: 'string' }, after: { type: 'integer' }, workersAfter: { type: 'integer' }, limit: { type: 'integer' }, history: { type: 'boolean' } }), additionalProperties: false };
const commandParameters = { ...parameterSchemaSpecToJsonSchema({ request: { type: 'string', required: true,
  description: 'JSON command: {commandId,command:{type,id,...}}. create adds sessionId,prompt,rule ({kind:"every",everySeconds>=300} or {kind:"at",at:ISO-with-offset}),missed (skip|coalesce|catch-up),catchUpLimit (1..100). approve adds instanceId. cancel-plan adds reason. cancel-instance adds instanceId and reason. Uncertain resolution is human-only.' } }), additionalProperties: false };

function failure(error: unknown): Response {
  if (error instanceof CommandInputError) return error.response();
  const code = error instanceof GovernanceDenied || error instanceof WatchdogScheduleError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError || error instanceof ScheduleInputError ? 'invalid_request' : 'unavailable';
  return Response.json({ error: { code, message: code === 'response_too_large' && error instanceof WatchdogScheduleError ? error.message : 'The schedule operation did not complete.' } }, {
    status: code === 'permission_denied' ? 403 : code === 'invalid_request' ? 400 : code === 'response_too_large' ? 413 : code === 'not_found' ? 404 : code === 'unavailable' ? 503 : 409,
    headers: { 'cache-control': 'no-store' },
  });
}
function bounded(value: unknown, maxBytes: number, transport: 'http' | 'tool'): string {
  const text = JSON.stringify(value);
  if (scheduleResponseBytes(value, transport) > maxBytes) throw new WatchdogScheduleError('response_too_large', 'Read a smaller schedule page.');
  return text;
}

/** Mount query, history and command paths; drain approvals before the durable store closes.
 * @param ctx - Existing authenticated Fetch, tools, approval and runtime services.
 * @param store - Open occurrence ledger, owned by the Host.
 * @param enterprise - Shared responsibility audit owner.
 * @param access - Current local or trusted enterprise caller resolution.
 * @returns Idempotent consumer withdrawal and in-flight approval drain.
 */
export async function mountWatchdogSchedules(ctx: EnterpriseHostContext & EnterpriseToolContext & WatchdogScheduleServices,
  store: WatchdogScheduleStore, enterprise: EnterpriseStore, access: GovernanceAccess, commands = new GovernanceCommandInput()): Promise<() => Promise<void>> {
  access.assertOrganization(store.organizationId);
  access.assertOrganization(enterprise.organizationId);
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const removals: Array<() => unknown> = [];
  let disposal: Promise<void> | undefined;
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const promise = Promise.resolve().then(() => { lifetime.signal.throwIfAborted(); return action(); });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const query = async (caller: GovernanceCaller, value: unknown, transport: 'http' | 'tool') => {
    const input = querySchema.parse(value);
    const identity = await caller.check('task.read', input.id ?? '*');
    lifetime.signal.throwIfAborted();
    if (input.history && (!input.id || input.workersAfter !== 0)) throw new WatchdogScheduleError('invalid_request', 'History requires a plan id and does not page workers.');
    const fits = (result: unknown) => scheduleResponseBytes(result, transport) <= store.config.maxQueryBytes;
    const result = input.history ? store.history(identity, input.id!, input.after, input.limit, fits)
      : store.query(identity, Date.now(), input.id, input.after, input.limit, fits, input.workersAfter);
    return bounded(result, store.config.maxQueryBytes, transport);
  };
  const command = async (caller: GovernanceCaller, input: ScheduleCommand, signal: AbortSignal, transport: 'http' | 'tool') => {
    const identity = await caller.check('task.write', input.command.id);
    signal.throwIfAborted();
    const replay = store.replay(identity, input, transport);
    if (replay) return bounded(replay, store.config.maxQueryBytes, transport);
    if (input.command.type === 'create') {
      const bound = await access.agent(input.command.sessionId, undefined, signal);
      const executor = await bound.check('task.write', input.command.id);
      if (executor.organizationId !== identity.organizationId || (access.mode === 'enterprise' && executor.principalId !== identity.principalId)) throw new GovernanceDenied('Bind a Session owned by the plan creator.');
    }
    const current = await caller.check('task.write', input.command.id);
    signal.throwIfAborted(); lifetime.signal.throwIfAborted();
    return bounded(store.command(current, input, Date.now(), transport), store.config.maxQueryBytes, transport);
  };
  const dispose = (): Promise<void> => disposal ??= (async () => {
    lifetime.abort(new Error('Schedule consumers unloaded.'));
    const results = await Promise.allSettled(removals.map(async remove => remove()));
    await Promise.allSettled(pending);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Schedule consumers could not be removed.');
  })();
  try {
    removals.push(ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch: request => run(async () => {
      const signal = AbortSignal.any([lifetime.signal, request.signal]);
      const search = new URL(request.url).searchParams;
      for (const key of search.keys()) if (!['id', 'after', 'workersAfter', 'limit', 'history'].includes(key) || search.getAll(key).length !== 1) throw new WatchdogScheduleError('invalid_request', 'Unknown or repeated schedule query field.');
      if (search.has('history') && !['true', 'false'].includes(search.get('history')!)) throw new WatchdogScheduleError('invalid_request', 'history must be true or false.');
      const value = await query(await access.http(request, signal), { ...(search.has('id') ? { id: search.get('id') } : {}),
        after: Number(search.get('after') ?? 0), workersAfter: Number(search.get('workersAfter') ?? 0), limit: Number(search.get('limit') ?? 50), history: search.get('history') === 'true' }, 'http');
      return new Response(value, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }).catch(failure) }));
    removals.push(ctx.connection.fetch.register({ path: `${path}/command`, methods: ['POST'], requestBody: 'streaming', fetch: request => run(() => commands.run(AbortSignal.any([lifetime.signal, request.signal]), async () => {
      const signal = AbortSignal.any([lifetime.signal, request.signal]);
      const { caller, value: inputValue } = await commands.receive(request, signal, inputSignal => access.http(request, inputSignal));
      if (!['local-human', 'member'].includes(caller.identity.actor.kind)) throw new GovernanceDenied('This path requires a human caller.');
      const input = scheduleCommandSchema.parse(inputValue);
      const value = await auditGovernanceOutcome(caller, enterprise, `schedule.${input.command.type}`, input.commandId, () => command(caller, input, signal, 'http'), signal);
      return new Response(value, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    })).catch(failure) }));
    removals.push(ctx.tools.register({ name: 'watchdog_schedule_query', description: 'Read persistent WatchDog plans, occurrences, heartbeats and history. after/nextAfter pages complete records within the output byte budget; workersAfter/workerSummary.nextAfter independently pages workers. workerSummary counts every current worker by status, including those on later pages. A single oversized record fails explicitly. Stale heartbeat means the worker is offline; dispatched confirms durable input delivery, not business completion. HTTP observation requires no live agent.',
      parameters: queryParameters, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: (args, exec) => run(async () => { const signal = AbortSignal.any([lifetime.signal, exec.signal]); signal.throwIfAborted(); return query(await access.agent(exec.agent?.id, exec.callId, signal), args, 'tool'); }),
      presentCall: args => ({ card: 'generic', title: 'Read WatchDog schedules', kind: 'search', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'WatchDog schedules', content: result.content }),
    }));
    removals.push(ctx.tools.register({ name: 'watchdog_schedule_command', description: 'Manage durable WatchDog prompt plans. Every occurrence waits for its own one-shot approval and expires if nobody approves. Creating a plan grants no future execution. Existing DSH tool approvals remain required. No cold Session is resumed; desktop execution stops when the app stops. Cancel-plan stops future occurrences only; cancel-instance cancels an unstarted occurrence. Only humans can resolve uncertain dispatch; it is never automatically replayed.',
      parameters: commandParameters, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: (args, exec) => run(() => commands.run(AbortSignal.any([lifetime.signal, exec.signal]), async () => {
        const signal = AbortSignal.any([lifetime.signal, exec.signal]);
        const caller = await access.agent(exec.agent?.id, exec.callId, signal);
        commands.checkArguments(args);
        const value = z.object({ request: z.string().max(16000) }).strict().parse(args);
        const input = scheduleCommandSchema.parse(JSON.parse(value.request));
        return auditGovernanceOutcome(caller, enterprise, `schedule.${input.command.type}`, input.commandId, async () => {
          if (!exec.agent || input.command.type === 'resolve-uncertain') throw new GovernanceDenied('Only a human may resolve uncertain dispatch.');
          const identity = await caller.check('task.write', input.command.id);
          signal.throwIfAborted();
          const replay = store.replay(identity, input, 'tool');
          if (replay) return bounded(replay, store.config.maxQueryBytes, 'tool');
          const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name, reason: `Approve only this schedule command: ${JSON.stringify(input)}`, signal });
          if (outcome !== 'allowed-once') throw new GovernanceDenied('Schedule command was not approved.');
          if (access.mode === 'local') caller.identity.approval = { kind: 'dsh-one-shot' };
          return command(caller, input, signal, 'tool');
        }, signal);
      })),
      presentCall: args => ({ card: 'generic', title: 'Change WatchDog schedule', kind: 'edit', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Schedule command failed' : 'Schedule command saved', content: result.content }),
    }));
    return dispose;
  } catch (error) { await dispose(); throw error; }
}
