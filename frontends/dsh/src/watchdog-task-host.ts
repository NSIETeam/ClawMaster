/** Authenticated HTTP and DSH tool consumers for the shared business task owner. */
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { EnterpriseHostContext, EnterpriseStore } from './enterprise-host.ts';
import type { EnterpriseToolContext } from './enterprise-tools.ts';
import { auditGovernanceOutcome, GovernanceAccess, GovernanceDenied } from './governance-access.ts';
import { EnterpriseError } from './enterprise-types.ts';
import { taskRequestSchema, TaskError } from './watchdog-tasks.ts';
import { taskCommandOutput, taskCommandParameters, taskQueryOutput, taskQueryParameters } from './watchdog-task-schemas.ts';

const tasksPath = '/api/clawmaster/tasks';
const commandPath = `${tasksPath}/command`;
const querySchema = z.object({ id: z.string().min(1).max(128).optional(), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50), history: z.boolean().default(false) }).strict();

function failure(error: unknown): Response {
  const code = error instanceof GovernanceDenied || error instanceof TaskError || error instanceof EnterpriseError ? error.code
    : error instanceof z.ZodError ? 'invalid_request' : 'storage_unavailable';
  return Response.json({ error: { code, message: error instanceof Error ? error.message : 'Task operation failed.' } },
    { status: code === 'permission_denied' ? 403 : code === 'invalid_request' ? 400 : code === 'not_found' ? 404 : code === 'storage_unavailable' ? 503 : 409,
      headers: { 'cache-control': 'no-store' } });
}

/** Register the actual task paths and tools, draining in-flight work before the shared database closes. */
export async function mountWatchdogTasks(ctx: EnterpriseHostContext & EnterpriseToolContext, store: EnterpriseStore, access: GovernanceAccess): Promise<() => Promise<void>> {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const removals: Array<() => unknown> = [];
  let disposal: Promise<void> | undefined;
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => { lifetime.signal.throwIfAborted(); return action(); });
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const query = (identity: Awaited<ReturnType<GovernanceAccess['http']>>['identity'], value: unknown) => {
    const parsed = querySchema.parse(value);
    if (parsed.id) return parsed.history ? store.tasks.history(identity, parsed.id, parsed.offset) : store.tasks.get(identity, parsed.id);
    if (parsed.history) throw new EnterpriseError('invalid_request', 'History requires a task identifier.');
    return store.tasks.list(identity, { offset: parsed.offset, limit: parsed.limit });
  };
  const dispose = (): Promise<void> => disposal ??= (async () => {
    lifetime.abort(new Error('Task consumers were unloaded.'));
    const removed = await Promise.allSettled(removals.map(async remove => remove()));
    await Promise.allSettled(pending);
    const failures = removed.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Task consumers could not be removed.');
  })();
  try {
    removals.push(ctx.connection.fetch.register({ path: tasksPath, methods: ['GET'], requestBody: 'buffered', fetch: request => run(async () => {
      const search = new URL(request.url).searchParams;
      const input = querySchema.parse({ ...(search.has('id') ? { id: search.get('id') } : {}), offset: Number(search.get('offset') ?? 0),
        limit: Number(search.get('limit') ?? 50), history: search.get('history') === 'true' });
      const caller = await access.http(request);
      const identity = await auditGovernanceOutcome(caller, store, 'task.read', undefined, () => caller.check('task.read', input.id ?? '*'));
      lifetime.signal.throwIfAborted(); request.signal.throwIfAborted();
      return Response.json(query(identity, input), { headers: { 'cache-control': 'no-store' } });
    }).catch(failure) }));
    removals.push(ctx.connection.fetch.register({ path: commandPath, methods: ['POST'], requestBody: 'buffered', fetch: request => run(async () => {
      const caller = await access.http(request);
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new EnterpriseError('invalid_request', 'Task commands require JSON.');
      const input = taskRequestSchema.parse(await request.json());
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      return auditGovernanceOutcome(caller, store, `task.${input.command.type}`, input.commandId, async () => {
        if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
        const action = input.command.type === 'review' ? 'task.review' : 'task.write';
        const checked = await caller.check(action, input.id);
        const replay = store.tasks.replay(checked, input);
        const identity = access.mode === 'enterprise' && action === 'task.write' && !replay
          ? await caller.approve(action, input.id, input.commandId, 0, input.revision,
            createHash('sha256').update(JSON.stringify(input.command)).digest('hex'))
          : checked;
        signal.throwIfAborted();
        if (replay) return Response.json(replay, { headers: { 'cache-control': 'no-store' } });
        return Response.json(store.tasks.execute(identity, input), { headers: { 'cache-control': 'no-store' } });
      }, signal);
    }).catch(failure) }));
    removals.push(ctx.tools.register({ name: 'watchdog_task_query', description: 'Read durable business tasks independently from Session run state. Read one id, its revision history, or a bounded task page. Idle Sessions do not imply accepted business results.',
      parameters: taskQueryParameters,
      output: { schema: taskQueryOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => run(async () => {
        const input = querySchema.parse(args);
        const caller = await access.agent(exec.agent?.id, exec.callId);
        const identity = await auditGovernanceOutcome(caller, store, 'task.read', undefined, () => caller.check('task.read', input.id ?? '*'));
        lifetime.signal.throwIfAborted(); exec.signal.throwIfAborted();
        return query(identity, input);
      }),
      presentCall: args => ({ card: 'generic', title: 'Read business task', kind: 'search', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'Business task', content: result.content }),
    }));
    removals.push(ctx.tools.register({ name: 'watchdog_task_command', description: 'Create a draft with owner, deadline, scope and acceptance criteria; queue, start, link a Session, wait, report failure or submit evidence. Use the current task revision and a unique commandId. Existing Sessions are imported only as drafts. Human review, cancellation and reopening are unavailable to agents. Submission never means acceptance. Every mutation requires one-shot approval.',
      parameters: taskCommandParameters,
      output: { schema: taskCommandOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => run(async () => {
        const input = taskRequestSchema.parse(args);
        const caller = await access.agent(exec.agent?.id, exec.callId);
        const signal = AbortSignal.any([exec.signal, lifetime.signal]);
        return auditGovernanceOutcome(caller, store, `task.${input.command.type}`, input.commandId, async () => {
          if (['review', 'cancel', 'reopen'].includes(input.command.type)) throw new GovernanceDenied('This task action requires a human.');
          const checked = await caller.check('task.write', input.id);
          if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
          if (!exec.agent) throw new GovernanceDenied();
          signal.throwIfAborted();
          const replay = store.tasks.replay(checked, input);
          if (replay) return replay;
          const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name,
            reason: `Approve this business task action at revision ${input.revision}: ${JSON.stringify(input)}`, signal });
          if (outcome !== 'allowed-once') throw new GovernanceDenied(`Task action ${outcome}.`, `approval_${outcome}`);
          if (input.command.type === 'create' || input.command.type === 'revise') await caller.checkOwner(input.command.task.owner);
          const identity = access.mode === 'enterprise'
            ? await caller.approve('task.write', input.id, input.commandId, 0, input.revision,
              createHash('sha256').update(JSON.stringify(input.command)).digest('hex'))
            : await caller.check('task.write', input.id);
          if (access.mode === 'local') identity.approval = { id: randomUUID(), approverId: 'local-operator', generation: 0, revision: input.revision };
          signal.throwIfAborted();
          return store.tasks.execute(identity, input);
        }, signal);
      }),
      presentCall: args => ({ card: 'generic', title: 'Update business task', kind: 'edit', rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Task action failed' : 'Task action saved', content: result.content }),
    }));
    return dispose;
  } catch (error) { await dispose(); throw error; }
}
