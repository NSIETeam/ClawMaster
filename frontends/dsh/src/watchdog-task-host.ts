/** Authenticated HTTP and DSH tool consumers for the shared business task owner. */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { GovernanceCommandInput, CommandInputError } from './command-input.ts';
import { createHash } from 'node:crypto';
import type { EnterpriseHostContext, EnterpriseStore } from './enterprise-host.ts';
import type { EnterpriseToolContext } from './enterprise-tools.ts';
import { auditGovernanceOutcome, governanceResource, governanceResourceCollection, GovernanceAccess, GovernanceDenied } from './governance-access.ts';
import type { GovernanceCaller } from './governance-access.ts';
import { EnterpriseError } from './enterprise-types.ts';
import { taskRequestSchema, TaskError } from './watchdog-tasks.ts';
import { taskExecutionOutcomeSchema, taskQuerySchema as querySchema } from './watchdog-task-format.ts';
import { taskCommandOutput, taskCommandParameters, taskQueryOutput, taskQueryParameters } from './watchdog-task-schemas.ts';
import type { ObservedTaskExecutionOutcome } from './governance-audit.ts';
import type { ExecutionIdentity } from './governance-audit.ts';
import type { TaskHistoryPage, TaskListPage, TaskRecord } from './watchdog-task-format.ts';
import type { StateCapsuleScope } from './watchdog-state-capsule.ts';

const tasksPath = '/api/clawmaster/tasks';
const commandPath = `${tasksPath}/command`;
type WatchdogTaskHostContext = Omit<Context, 'sessions' | 'sessionPersistence' | 'workspaceRegistry'> & {
  sessions: SessionStore;
  sessionPersistence: SessionPersistence;
  workspaceRegistry?: { get(id: string): { sessionIds: readonly string[] } | undefined };
};

function capsuleOwnerId(identity: ExecutionIdentity): string {
  return identity.organizationId === 'local' ? 'local-operator' : (identity.principalId ?? identity.actor.id);
}

/** Apply principal ownership and current Workspace/Session membership to persisted task capsules.
 * @param task - Durable task record whose capsules are being projected.
 * @param identity - Authenticated caller identity.
 * @param ctx - Host registry used to verify current project membership.
 * @returns The task with capsules visible to this caller.
 */
export function taskWithVisibleCapsules(task: TaskRecord, identity: ExecutionIdentity, ctx: WatchdogTaskHostContext): TaskRecord {
  const ownerId = capsuleOwnerId(identity);
  return { ...task, stateCapsules: task.stateCapsules.filter(capsule => {
    if (capsule.ownerId !== ownerId) return false;
    if (capsule.scope.kind === 'session') return task.sessionIds.includes(capsule.scope.id);
    if (capsule.scope.kind === 'project') {
      const workspace = ctx.workspaceRegistry?.get(capsule.scope.id);
      return workspace !== undefined && task.sessionIds.some(sessionId => workspace.sessionIds.includes(sessionId));
    }
    return true;
  }) };
}

/** Reject capsule writes outside the caller's task-linked Workspace and Session scope.
 * @param ctx - Host registry used to verify project membership.
 * @param access - Governance policy used to authorize linked Sessions.
 * @param identity - Authenticated caller identity.
 * @param task - Current durable task record.
 * @param scope - Requested capsule scope.
 * @param taskId - Durable task identifier.
 * @param signal - Cancellation signal for governance checks.
 * @returns Resolves only when the scope is valid and authorized.
 */
export async function validateCapsuleScope(ctx: WatchdogTaskHostContext, access: GovernanceAccess, identity: ExecutionIdentity,
  task: TaskRecord, scope: StateCapsuleScope, taskId: string, signal: AbortSignal): Promise<void> {
  if (scope.kind === 'user') return;
  if (scope.kind === 'project') {
    const workspace = ctx.workspaceRegistry?.get(scope.id);
    if (workspace === undefined) {
      throw new EnterpriseError('invalid_request', 'State capsule project must name an existing Workspace.');
    }
    const linkedSessionId = task.sessionIds.find(sessionId => workspace.sessionIds.includes(sessionId));
    if (!linkedSessionId) {
      throw new GovernanceDenied('Task is not linked to a Session in this project.');
    }
    await assertExecutionSessionOwner(access, identity, linkedSessionId, taskId, signal);
    return;
  }
  if (!task.sessionIds.includes(scope.id)) {
    throw new EnterpriseError('invalid_request', 'State capsule Session must already be linked to this task.');
  }
  await assertExecutionSessionOwner(access, identity, scope.id, taskId, signal);
}

function taskQueryWithVisibleCapsules(value: TaskRecord | TaskListPage | TaskHistoryPage,
  identity: ExecutionIdentity, ctx: WatchdogTaskHostContext): TaskRecord | TaskListPage | TaskHistoryPage {
  if ('tasks' in value) return { ...value, tasks: value.tasks.map(task => taskWithVisibleCapsules(task, identity, ctx)) };
  return taskWithVisibleCapsules(value, identity, ctx);
}

function taskExecutionOutcome(reason: { kind: string }): { outcome: 'succeeded' } | { outcome: 'failed'; reasonCode: string } | undefined {
  switch (reason.kind) {
    case 'completed': return { outcome: 'succeeded' };
    case 'error': return { outcome: 'failed', reasonCode: 'session_turn_error' };
    case 'blocked': return { outcome: 'failed', reasonCode: 'session_turn_blocked' };
    case 'aborted': return { outcome: 'failed', reasonCode: 'session_turn_aborted' };
    case 'interrupted': return { outcome: 'failed', reasonCode: 'session_turn_interrupted' };
    case 'max-tokens': return { outcome: 'failed', reasonCode: 'session_max_tokens' };
    default: return undefined;
  }
}

function retryableAuditFailure(error: unknown): boolean {
  if (error instanceof EnterpriseError) return error.code === 'storage_unavailable';
  if (!(error instanceof Error)) return false;
  return /SQLITE_(?:BUSY|LOCKED|IOERR|CANTOPEN|FULL)|database is locked|disk I\/O error/i.test(
    `${'code' in error ? String(error.code) : ''} ${error.message}`);
}

interface PersistedInboxMessage { source?: { kind?: string; rpcId?: string } }
interface PersistedInboxSplice { target: 'next-turn' | 'next-step'; start: number; removedCount?: number; inserted: PersistedInboxMessage[]; outcome?: string }
interface PersistedTurnReason { kind: string }
type PersistedInboxes = Record<PersistedInboxSplice['target'], PersistedInboxMessage[]>;
const inboxSpliceSchema = z.object({ target: z.enum(['next-turn', 'next-step']), start: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative().optional(), inserted: z.array(z.object({
    source: z.object({ kind: z.string(), rpcId: z.string().optional() }).passthrough().optional(),
  }).passthrough()), outcome: z.string().optional() }).strict();

function applyInboxSplice(queues: PersistedInboxes, data: PersistedInboxSplice): PersistedInboxMessage[] {
  const queue = queues[data.target];
  const count = data.removedCount ?? 0;
  const removed = queue.slice(data.start, data.start + count);
  const nextQueue = queue.slice();
  nextQueue.splice(data.start, count, ...data.inserted);
  queues[data.target] = nextQueue;
  return removed;
}

function canceledRequest(data: PersistedInboxSplice, removed: readonly PersistedInboxMessage[], requestId: string): boolean {
  const removedRequest = removed.some(message => message.source?.kind === 'user' && message.source.rpcId === requestId);
  const retainedRequest = data.inserted.some(message => message.source?.kind === 'user' && message.source.rpcId === requestId);
  return data.outcome === 'canceled' && removedRequest && !retainedRequest;
}

/** Recover the outcome for one request by replaying the durable inbox and turn events. */
function replayTaskExecutionOutcome(events: readonly { type: string; data: unknown }[], requestId: string): {
  outcome?: Omit<ObservedTaskExecutionOutcome, 'sessionId' | 'requestId'>;
  activeTurn?: { turn: number; claimed: boolean; inputLogged: boolean };
  inboxes: PersistedInboxes;
} {
  const queues: PersistedInboxes = { 'next-turn': [], 'next-step': [] };
  let turn: number | undefined;
  let claimed = false;
  let inputLogged = false;
  let result: Omit<ObservedTaskExecutionOutcome, 'sessionId' | 'requestId'> | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      const data = z.object({ turn: z.number().int().nonnegative() }).parse(event.data);
      turn = data.turn;
      claimed = false;
      inputLogged = false;
      continue;
    }
  if (event.type === 'agent/inbox/spliced') {
      const data = inboxSpliceSchema.parse(event.data) as PersistedInboxSplice;
      const removed = applyInboxSplice(queues, data);
      const count = data.removedCount ?? 0;
      const reinsertedRequest = data.inserted.some(message => message.source?.kind === 'user' && message.source.rpcId === requestId);
      const isClaim = turn !== undefined && data.outcome === undefined && data.inserted.length === 0 && count > 0
        && (data.target === 'next-step' && data.start === 0 || data.target === 'next-turn' && data.start === 0 && count === 1);
      if (isClaim && removed.some(message => message.source?.kind === 'user' && message.source.rpcId === requestId)) claimed = true;
      if (reinsertedRequest && result?.reasonCode === 'session_request_canceled') result = undefined;
      if (canceledRequest(data, removed, requestId)) result = { outcome: 'failed', reasonCode: 'session_request_canceled' };
      continue;
    }
      if (event.type === 'user/message' && turn !== undefined) {
      const data = z.object({ source: z.object({ kind: z.string(), rpcId: z.string().optional() }).passthrough() }).passthrough().parse(event.data);
      if (data.source.kind === 'user' && data.source.rpcId === requestId) { claimed = true; inputLogged = true; }
      continue;
    }
    if (event.type === 'turn/end') {
      const data = z.object({ turn: z.number().int().nonnegative(), reason: z.object({ kind: z.string() }).passthrough() }).parse(event.data);
      if (turn === data.turn && claimed) {
        const outcome = taskExecutionOutcome(data.reason as PersistedTurnReason);
        if (outcome?.outcome === 'failed' || outcome?.outcome === 'succeeded' && inputLogged) result = outcome;
      }
      if (turn === data.turn) { turn = undefined; claimed = false; inputLogged = false; }
    }
  }
  return {
    ...(result ? { outcome: result } : {}),
    ...(turn !== undefined ? { activeTurn: { turn, claimed, inputLogged } } : {}),
    inboxes: queues,
  };
}

async function assertExecutionSessionOwner(access: GovernanceAccess, identity: Awaited<ReturnType<GovernanceCaller['check']>>,
  sessionId: string, taskId: string, signal: AbortSignal): Promise<void> {
  if (access.mode !== 'enterprise') return;
  const target = await access.agent(sessionId, undefined, signal);
  const targetIdentity = await target.check('task.write', governanceResource('task', taskId));
  if (targetIdentity.organizationId !== identity.organizationId || targetIdentity.principalId !== identity.principalId) {
    throw new GovernanceDenied('The target Session does not belong to the task owner in this organization.');
  }
}

function failure(error: unknown): Response {
  if (error instanceof CommandInputError) return error.response();
  const code = error instanceof GovernanceDenied || error instanceof TaskError || error instanceof EnterpriseError ? error.code
    : error instanceof z.ZodError ? 'invalid_request' : 'storage_unavailable';
  const message = error instanceof z.ZodError ? 'Task request fields are invalid.'
    : error instanceof GovernanceDenied || error instanceof TaskError || error instanceof EnterpriseError ? error.message : 'Task operation failed.';
  return Response.json({ error: { code, message } },
    { status: code === 'permission_denied' ? 403 : code === 'invalid_request' ? 400 : code === 'response_too_large' ? 413 : code === 'not_found' ? 404 : code === 'storage_unavailable' ? 503 : 409,
      headers: { 'cache-control': 'no-store' } });
}

/** Register the actual task paths and tools, draining in-flight work before the shared database closes. */
export async function mountWatchdogTasks(ctx: EnterpriseHostContext & EnterpriseToolContext & WatchdogTaskHostContext, store: EnterpriseStore, access: GovernanceAccess, commands = new GovernanceCommandInput()): Promise<() => Promise<void>> {
  access.assertOrganization(store.organizationId);
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const removals: Array<() => unknown> = [];
  const sessionTurns = new Map<string, { turn: number; requestIds: Set<string>; inputRequestIds: Set<string> }>();
  const sessionEventRevisions = new Map<string, number>();
  const sessionInboxes = new Map<string, PersistedInboxes>();
  const sessionPersistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined;
  let disposal: Promise<void> | undefined;
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => { lifetime.signal.throwIfAborted(); return action(); }).catch(error => {
      if (error instanceof z.ZodError) throw new EnterpriseError('invalid_request', 'Task request fields are invalid.');
      throw error;
    });
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const waitForAuditRetry = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, store.tasks.outcomeRetryMs);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
  const recordObservedOutcome = async (value: ObservedTaskExecutionOutcome, signal: AbortSignal): Promise<void> => {
    while (true) {
      signal.throwIfAborted();
      try {
        store.recordObservedTaskExecutionOutcome(value);
        return;
      } catch (error) {
        if (!retryableAuditFailure(error)) throw error;
        await waitForAuditRetry(signal);
      }
    }
  };
  const reconcileRequest = async (requestId: string, sessionId: string, signal: AbortSignal): Promise<void> => {
    if (!sessionPersistence) return;
    while (true) {
      const revision = sessionEventRevisions.get(sessionId) ?? 0;
      signal.throwIfAborted();
      const sessions = ctx.sessions;
      const liveSession = sessions?.get(SessionId(sessionId));
      if (sessions && liveSession) await sessions.flush(liveSession);
      const handle = await sessionPersistence.open(SessionId(sessionId), 'read', { signal });
      let replay: ReturnType<typeof replayTaskExecutionOutcome>;
      try {
        const { events } = await handle.read(0, undefined, { signal });
        replay = replayTaskExecutionOutcome(events, requestId);
      } finally {
        await handle.close();
      }
      if (revision !== (sessionEventRevisions.get(sessionId) ?? 0)) continue;
      if (replay.outcome) await recordObservedOutcome({ requestId, sessionId, ...replay.outcome }, signal);
      sessionInboxes.set(sessionId, replay.inboxes);
      if (replay.activeTurn !== undefined) {
        const active = sessionTurns.get(sessionId);
        if (!active || active.turn < replay.activeTurn.turn) {
          sessionTurns.set(sessionId, { turn: replay.activeTurn.turn,
            requestIds: new Set(replay.activeTurn.claimed ? [requestId] : []),
            inputRequestIds: new Set(replay.activeTurn.inputLogged ? [requestId] : []) });
        } else if (active.turn === replay.activeTurn.turn && replay.activeTurn.claimed) {
          active.requestIds.add(requestId);
          if (replay.activeTurn.inputLogged) active.inputRequestIds.add(requestId);
        }
      }
      return;
    }
  };
  const reconcilePending = async (signal: AbortSignal): Promise<void> => {
    for (const pendingOutcome of store.pendingTaskExecutionOutcomes()) {
      signal.throwIfAborted();
      try {
        await reconcileRequest(pendingOutcome.requestId, pendingOutcome.sessionId, signal);
      } catch (error) {
        if (!signal.aborted) ctx.logger.warn(`WatchDog task Session replay could not reconcile ${pendingOutcome.requestId}: ${String(error)}`);
      }
    }
  };
  const query = (identity: Awaited<ReturnType<GovernanceAccess['http']>>['identity'], value: unknown) => {
    const parsed = querySchema.parse(value);
    if (parsed.id) return taskQueryWithVisibleCapsules(parsed.history
      ? store.tasks.history(identity, parsed.id, parsed.after, parsed.limit)
      : store.tasks.get(identity, parsed.id), identity, ctx);
    if (parsed.history) throw new EnterpriseError('invalid_request', 'History requires a task identifier.');
    return taskQueryWithVisibleCapsules(store.tasks.list(identity, { ...(parsed.cursor ? { cursor: parsed.cursor } : {}), limit: parsed.limit }), identity, ctx);
  };
  const dispose = (): Promise<void> => disposal ??= (async () => {
    lifetime.abort(new Error('Task consumers were unloaded.'));
    const removed = await Promise.allSettled(removals.map(async remove => remove()));
    await Promise.allSettled(pending);
    const failures = removed.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Task consumers could not be removed.');
  })();
  try {
    removals.push(ctx.on('session/event', (session: Session, event) => {
      const sessionId = String(session.id);
      sessionEventRevisions.set(sessionId, (sessionEventRevisions.get(sessionId) ?? 0) + 1);
      if (event.type === 'agent/inbox/spliced') {
        const data = event.data;
        const queues = sessionInboxes.get(sessionId) ?? { 'next-turn': [], 'next-step': [] };
        applyInboxSplice(queues, data);
        sessionInboxes.set(sessionId, queues);
        if (data.outcome === 'canceled' && sessionPersistence) {
          void run(() => reconcilePending(lifetime.signal)).catch(error => {
            if (!lifetime.signal.aborted) ctx.logger.warn(`WatchDog canceled Session requests could not be replayed: ${String(error)}`);
          });
        }
        return;
      }
      if (event.type === 'turn/start') {
        sessionTurns.set(sessionId, { turn: event.data.turn, requestIds: new Set(), inputRequestIds: new Set() });
        return;
      }
      const current = sessionTurns.get(sessionId);
      if (!current) return;
      if (event.type === 'user/message') {
        const { source } = event.data;
        if (source.kind === 'user' && 'rpcId' in source) {
          current.requestIds.add(String(source.rpcId));
          current.inputRequestIds.add(String(source.rpcId));
        }
        return;
      }
      if (event.type !== 'turn/end' || current.turn !== event.data.turn) return;
      sessionTurns.delete(sessionId);
      const outcome = taskExecutionOutcome(event.data.reason);
      if (!outcome) return;
      for (const requestId of current.requestIds) {
        if (outcome.outcome === 'succeeded' && !current.inputRequestIds.has(requestId)) continue;
        try {
          void run(() => recordObservedOutcome({ sessionId, requestId, ...outcome }, lifetime.signal)).catch(error => {
            if (!lifetime.signal.aborted) ctx.logger.warn(`WatchDog task Session outcome reconciliation stopped: ${String(error)}`);
          });
        } catch (error) {
          ctx.logger.warn(`WatchDog task Session outcome could not be recorded: ${String(error)}`);
        }
      }
    }));
    removals.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const current = sessionTurns.get(String(agent.session.id));
      if (!current || current.turn !== turn) return;
      const { source } = message;
      if (source.kind === 'user' && 'rpcId' in source) current.requestIds.add(String(source.rpcId));
    }));
    removals.push(ctx.connection.fetch.register({ path: tasksPath, methods: ['GET'], requestBody: 'buffered', fetch: request => run(async () => {
      const signal = AbortSignal.any([lifetime.signal, request.signal]);
      const search = new URL(request.url).searchParams;
      const values: Record<string, unknown> = Object.fromEntries(search);
      if ([...search.keys()].some(key => search.getAll(key).length !== 1)) throw new EnterpriseError('invalid_request', 'Task query fields must not repeat.');
      for (const key of ['after', 'limit']) if (search.has(key)) values[key] = Number(search.get(key));
      if (search.has('history')) values['history'] = search.get('history') === 'true' ? true : search.get('history') === 'false' ? false : search.get('history');
      if (search.has('cursor')) {
        try { values['cursor'] = JSON.parse(search.get('cursor')!); }
        catch { throw new EnterpriseError('invalid_request', 'Task list cursor must be JSON.'); }
      }
      const input = querySchema.parse(values);
      const caller = await access.http(request, signal);
      const resource = input.id ? governanceResource('task', input.id) : governanceResourceCollection('task');
      const identity = await auditGovernanceOutcome(caller, store, 'task.read', undefined, () => caller.check('task.read', resource));
      lifetime.signal.throwIfAborted(); request.signal.throwIfAborted();
      return Response.json(query(identity, input), { headers: { 'cache-control': 'no-store' } });
    }).catch(failure) }));
    removals.push(ctx.connection.fetch.register({ path: commandPath, methods: ['POST'], requestBody: 'streaming', fetch: request => run(() => commands.run(AbortSignal.any([request.signal, lifetime.signal]), async () => {
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const { caller, value } = await commands.receive(request, signal, inputSignal => access.http(request, inputSignal));
      const input = taskRequestSchema.parse(value);
      return auditGovernanceOutcome(caller, store, `task.${input.command.type}`, input.commandId, async () => {
        const action = input.command.type === 'review' ? 'task.review' : 'task.write';
        const resource = governanceResource('task', input.id);
        const checked = await caller.check(action, resource);
        if (input.command.type === 'start') await assertExecutionSessionOwner(access, checked, input.command.sessionId, input.id, signal);
        if (input.command.type === 'capsule') await validateCapsuleScope(ctx, access, checked,
          store.tasks.get(checked, input.id), input.command.scope, input.id, signal);
        if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
        const replay = store.tasks.replay(checked, input);
        const identity = access.mode === 'enterprise' && action === 'task.write' && !replay
          ? await caller.approve(action, resource, input.commandId, 0, input.revision,
            createHash('sha256').update(JSON.stringify(input.command)).digest('hex'))
          : checked;
        signal.throwIfAborted();
        if (replay) return Response.json(taskWithVisibleCapsules(replay, checked, ctx), { headers: { 'cache-control': 'no-store' } });
        if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
        if (input.command.type === 'start') await assertExecutionSessionOwner(access, await caller.check(action, resource), input.command.sessionId, input.id, signal);
        if (input.command.type === 'capsule') await validateCapsuleScope(ctx, access, identity,
          store.tasks.get(identity, input.id), input.command.scope, input.id, signal);
        signal.throwIfAborted();
        return Response.json(taskWithVisibleCapsules(store.tasks.execute(identity, input), identity, ctx), { headers: { 'cache-control': 'no-store' } });
      }, signal);
    })).catch(failure) }));
    removals.push(ctx.connection.fetch.register({ path: `${tasksPath}/execution-outcome`, methods: ['POST'], requestBody: 'streaming', fetch: request => run(() => commands.run(AbortSignal.any([request.signal, lifetime.signal]), async () => {
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const { caller, value } = await commands.receive(request, signal, inputSignal => access.http(request, inputSignal));
      const input = taskExecutionOutcomeSchema.parse(value);
      if (input.outcome !== 'uncertain') throw new GovernanceDenied('The browser cannot certify a DSH Session admission outcome.');
      const identity = await caller.check('task.write', governanceResource('task', input.taskId));
      await assertExecutionSessionOwner(access, identity, input.sessionId, input.taskId, signal);
      signal.throwIfAborted();
      const task = store.tasks.get(identity, input.taskId);
      if (task.execution?.requestId !== input.requestId || task.execution.sessionId !== input.sessionId) {
        throw new EnterpriseError('command_conflict', 'Task execution request is no longer current.');
      }
      if (!task.execution.commandId) throw new EnterpriseError('command_conflict', 'Task execution has no durable start command.');
      if (store.pendingTaskExecutionOutcomes().some(item => item.requestId === input.requestId && item.sessionId === input.sessionId)) {
        try { await reconcileRequest(input.requestId, input.sessionId, signal); }
        catch (error) { ctx.logger.warn(`WatchDog task Session retry replay could not reconcile ${input.requestId}: ${String(error)}`); }
      }
      const receipt = store.recordTaskExecutionOutcome(identity, input);
      return Response.json({ outcome: receipt.outcome }, { headers: { 'cache-control': 'no-store' } });
    })).catch(failure) }));
    removals.push(ctx.tools.register({ name: 'watchdog_task_query', description: `Read durable business tasks independently from Session run state. Read one id, its revision history, or a task page bounded to ${store.tasks.maxResponseBytes} UTF-8 bytes including tool output. Pass nextCursor unchanged as cursor to continue a list; refresh from the first page after a revision conflict. Continue history with nextAfter in the after argument. Idle Sessions do not imply accepted business results.`,
      parameters: taskQueryParameters,
      output: { schema: taskQueryOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => run(async () => {
        const input = querySchema.parse(args);
        const signal = AbortSignal.any([exec.signal, lifetime.signal]);
        const caller = await access.agent(exec.agent?.id, exec.callId, signal);
        const resource = input.id ? governanceResource('task', input.id) : governanceResourceCollection('task');
        const identity = await auditGovernanceOutcome(caller, store, 'task.read', undefined, () => caller.check('task.read', resource));
        lifetime.signal.throwIfAborted(); exec.signal.throwIfAborted();
        return query(identity, input);
      }),
      presentCall: args => ({ card: 'generic', title: 'Read business task', kind: 'search', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'Business task', content: result.content }),
    }));
    removals.push(ctx.tools.register({ name: 'watchdog_task_command', description: 'Create a draft with owner, deadline, scope and acceptance criteria; queue, start, link a Session, wait, report failure or submit evidence. A start command includes a unique requestId and durably binds it to the selected Session so the same task input can be retried after uncertain admission. Use the current task revision and a unique commandId. Existing Sessions are imported only as drafts. Human review, cancellation and reopening are unavailable to agents. Submission never means acceptance. Every mutation requires one-shot approval.',
      parameters: taskCommandParameters,
      output: { schema: taskCommandOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => run(() => commands.run(AbortSignal.any([exec.signal, lifetime.signal]), async () => {
        const signal = AbortSignal.any([exec.signal, lifetime.signal]);
        const caller = await access.agent(exec.agent?.id, exec.callId, signal);
        commands.checkArguments(args);
        const input = taskRequestSchema.parse(args);
        return auditGovernanceOutcome(caller, store, `task.${input.command.type}`, input.commandId, async () => {
          if (['review', 'cancel', 'reopen'].includes(input.command.type)) throw new GovernanceDenied('This task action requires a human.');
          const resource = governanceResource('task', input.id);
          const checked = await caller.check('task.write', resource);
          if (input.command.type === 'start') await assertExecutionSessionOwner(access, checked, input.command.sessionId, input.id, signal);
          if (input.command.type === 'capsule') await validateCapsuleScope(ctx, access, checked,
            store.tasks.get(checked, input.id), input.command.scope, input.id, signal);
          if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
          if (!exec.agent) throw new GovernanceDenied();
          signal.throwIfAborted();
          const replay = store.tasks.replay(checked, input);
          if (replay) return taskWithVisibleCapsules(replay, checked, ctx);
          const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name,
            reason: `Approve this business task action at revision ${input.revision}: ${JSON.stringify(input)}`, signal });
          if (outcome !== 'allowed-once') throw new GovernanceDenied(`Task action ${outcome}.`, `approval_${outcome}`);
          if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
          if (input.command.type === 'start') await assertExecutionSessionOwner(access, await caller.check('task.write', resource), input.command.sessionId, input.id, signal);
          const identity = access.mode === 'enterprise'
            ? await caller.approve('task.write', resource, input.commandId, 0, input.revision,
              createHash('sha256').update(JSON.stringify(input.command)).digest('hex'))
            : await caller.check('task.write', resource);
          if (input.command.type === 'start') await assertExecutionSessionOwner(access, identity, input.command.sessionId, input.id, signal);
          if (input.command.type === 'capsule') await validateCapsuleScope(ctx, access, identity,
            store.tasks.get(identity, input.id), input.command.scope, input.id, signal);
          if (access.mode === 'local') identity.approval = { kind: 'dsh-one-shot' };
          if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
          signal.throwIfAborted();
          return taskWithVisibleCapsules(store.tasks.execute(identity, input), identity, ctx);
        }, signal);
      })),
      presentCall: args => ({ card: 'generic', title: 'Update business task', kind: 'edit', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Task action failed' : 'Task action saved', content: result.content }),
    }));
    if (sessionPersistence) {
      void run(() => reconcilePending(lifetime.signal)).catch(error => {
        if (!lifetime.signal.aborted) ctx.logger.warn(`WatchDog task Session replay could not finish: ${String(error)}`);
      });
    }
    return dispose;
  } catch (error) { await dispose(); throw error; }
}
