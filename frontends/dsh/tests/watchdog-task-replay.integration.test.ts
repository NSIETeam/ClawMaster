import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { openEnterpriseStore } from '../src/enterprise-host.ts'
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts'
import { GovernanceAccess } from '../src/governance-access.ts'
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts'

const definition = { goal: 'Review selected customer', scope: 'Use only the selected account',
  owner: { kind: 'local' as const, label: 'Local manager' }, dueAt: null, timezone: 'UTC', risk: 'low' as const,
  checklist: [{ id: 'result', description: 'Record the verified result' }] }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('WatchDog durable DSH dispatch replay', () => {
  it.each([
    ['pre-step rejection', 'blocked', 'session_turn_blocked'],
    ['abort immediately after inbox claim', 'aborted', 'session_turn_aborted'],
    ['prompt assembly failure', 'assembly-error', 'session_turn_error'],
    ['empty pre-step completion without a model step', 'noop-empty', ''],
    ['observer remount during an active claimed turn', 'mid-flight-remount', 'session_turn_blocked'],
    ['remount waits for an in-flight persistence batch before replay', 'persist-pending-remount', 'session_turn_blocked'],
    ['same-turn reload with another pending Session request', 'same-turn-pending', 'session_turn_blocked'],
    ['live queued request cancellation before claim', 'queued-cancel-live', 'session_request_canceled'],
    ['replayed queued request cancellation before claim', 'queued-cancel-replay', 'session_request_canceled'],
    ['live same-request steering move', 'queued-steer-live', ''],
    ['replayed same-request steering move', 'queued-steer-replay', ''],
    ['live same-request queued edit', 'queued-edit-live', ''],
    ['replayed same-request queued edit', 'queued-edit-replay', ''],
    ['observer audit write failure followed by retry', 'observer-write-fail', 'session_turn_blocked'],
  ] as const)('reconciles a %s after the task Host observer is remounted', async (_label, mode, reasonCode) => {
    const root = await mkdtemp(join(tmpdir(), 'watchdog-task-replay-'))
    roots.push(root)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const store = await openEnterpriseStore(join(root, 'enterprise.sqlite'))
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    Object.assign(ctx, { connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
      routes.set(route.path, route.fetch)
      return () => routes.delete(route.path)
    } } } })
    let disposeHost: (() => Promise<void>) | undefined
    let disposeAgent: (() => Promise<void>) | undefined
    let releasePersistenceForCleanup: (() => void) | undefined
    let releasePreStepForCleanup: (() => void) | undefined
    let restorePersistenceSpy: (() => void) | undefined
    let restoreOpenSpy: (() => void) | undefined
    const originalRecordObserved = store.recordObservedTaskExecutionOutcome.bind(store)
    try {
      const sessionId = SessionId(`replay-${mode}`)
      const handle = await ctx.agents.create({ sessionId,
        agentOptions: { provider: 'mock', model: 'mock' } })
      disposeAgent = handle.dispose
      const taskId = `task-${mode}`
      const requestId = `request-${mode}`
      const secondTaskId = `task-b-${mode}`
      const secondRequestId = `request-b-${mode}`
      store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: taskId, revision: 0, commandId: `${taskId}-create`,
        command: { type: 'create', task: definition } })
      store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: taskId, revision: 1, commandId: `${taskId}-queue`, command: { type: 'queue' } })
      store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: taskId, revision: 2, commandId: `${taskId}-start`,
        command: { type: 'start', sessionId, requestId } })
      if (mode === 'same-turn-pending') {
        store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: secondTaskId, revision: 0, commandId: `${secondTaskId}-create`,
          command: { type: 'create', task: definition } })
        store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: secondTaskId, revision: 1, commandId: `${secondTaskId}-queue`, command: { type: 'queue' } })
        store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: secondTaskId, revision: 2, commandId: `${secondTaskId}-start`,
          command: { type: 'start', sessionId, requestId: secondRequestId } })
      }
      disposeHost = await mountWatchdogTasks(ctx as never, store, new GovernanceAccess())
      const postUncertainFor = (targetTaskId: string, targetRequestId: string) => routes.get('/api/clawmaster/tasks/execution-outcome')!(new Request('http://fixture/api/clawmaster/tasks/execution-outcome', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: targetTaskId, requestId: targetRequestId, sessionId, outcome: 'uncertain' }),
      }))
      const postUncertain = () => postUncertainFor(taskId, requestId)
      const initialUncertain = await postUncertain()
      expect(initialUncertain.status, await initialUncertain.clone().text()).toBe(200)
      if (mode === 'same-turn-pending') expect((await postUncertainFor(secondTaskId, secondRequestId)).status).toBe(200)

      const rejectPreStep = async (_payload: unknown, _next: unknown) => ({ kind: 'reject' as const })
      if (mode === 'blocked' || mode === 'observer-write-fail' || mode === 'persist-pending-remount') {
        ctx.on('agent/pre-step', rejectPreStep as never)
      }
      let releasePreStep!: () => void
      let preStepReached!: () => void
      const preStepGate = new Promise<void>(resolve => { releasePreStep = resolve })
      releasePreStepForCleanup = releasePreStep
      const preStepStarted = new Promise<void>(resolve => { preStepReached = resolve })
      if (mode === 'noop-empty') {
        ctx.on('agent/pre-step', () => ({ kind: 'enter' as const, messages: [] }) as never)
      } else if (mode.startsWith('queued-cancel') || mode.startsWith('queued-steer') || mode.startsWith('queued-edit')) {
        ctx.on('agent/pre-step', (async ({ signal }, next) => {
          preStepReached()
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          return next()
        }) as never)
      } else if (mode === 'mid-flight-remount' || mode === 'same-turn-pending' || mode === 'persist-pending-remount') {
        ctx.on('agent/pre-step', (async (_payload, _next) => {
          preStepReached()
          await preStepGate
          return { kind: 'reject' as const }
        }) as never)
      }
      if (mode === 'observer-write-fail') {
        store.recordObservedTaskExecutionOutcome = () => { throw new Error('injected terminal audit write failure') }
      } else if (mode !== 'noop-empty' && mode !== 'queued-cancel-live' && mode !== 'queued-cancel-replay'
        && mode !== 'queued-steer-live' && mode !== 'queued-steer-replay'
        && mode !== 'queued-edit-live' && mode !== 'queued-edit-replay') {
        await disposeHost()
        disposeHost = undefined
      }
      let releasePersistence!: () => void
      let persistenceBatchReady: Promise<void> | undefined
      let openReadCount = 0
      if (mode === 'persist-pending-remount') {
        const persistence = ctx.sessionPersistence as unknown as {
          persistBatch: (...args: unknown[]) => Promise<void>
          open: (...args: unknown[]) => Promise<unknown>
        }
        const originalPersist = persistence.persistBatch.bind(persistence)
        const originalOpen = persistence.open.bind(persistence)
        let persistenceEntered!: () => void
        persistenceBatchReady = new Promise<void>(resolve => { persistenceEntered = resolve })
        const persistenceGate = new Promise<void>(resolve => { releasePersistence = resolve })
        releasePersistenceForCleanup = releasePersistence
        const persistSpy = vi.spyOn(persistence, 'persistBatch').mockImplementation(async (...args) => {
          persistenceEntered()
          await persistenceGate
          await originalPersist(...args)
        })
        const openSpy = vi.spyOn(persistence, 'open').mockImplementation(async (...args) => {
          if (args[1] === 'read') openReadCount += 1
          return originalOpen(...args)
        })
        restorePersistenceSpy = () => persistSpy.mockRestore()
        restoreOpenSpy = () => openSpy.mockRestore()
      }
      if (mode === 'aborted') {
        ctx.on('agent/inbox/claimed', ({ agent, message }) => {
          if (message.source.kind === 'user' && message.source.rpcId === requestId) agent.cancel({ kind: 'user' })
        })
      } else if (mode === 'assembly-error') {
        ctx.systemPrompt.section({ name: 'watchdog-replay-failure-test', order: 999,
          text: () => { throw new Error('injected prompt assembly failure') } })
      }
      if (mode.startsWith('queued-cancel')) {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Unrelated running turn' }],
          source: { kind: 'user', rpcId: 'unrelated-turn' } }))
        await preStepStarted
        let queued!: () => void
        const taskQueued = new Promise<void>(resolve => { queued = resolve })
        const removeQueueListener = ctx.on('session/event', ((session, event) => {
          if (String(session.id) === String(sessionId) && event.type === 'agent/inbox/spliced'
            && event.data.inserted.some(message => message.source.kind === 'user' && message.source.rpcId === requestId)) queued()
        }) as never)
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Persisted task brief' }],
          source: { kind: 'user', rpcId: requestId } }))
        await taskQueued
        removeQueueListener()
        if (mode === 'queued-cancel-replay') {
          await disposeHost()
          disposeHost = undefined
        }
        handle.agent.cancel({ kind: 'user' })
      } else if (mode.startsWith('queued-steer') || mode.startsWith('queued-edit')) {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Unrelated running turn' }],
          source: { kind: 'user', rpcId: 'unrelated-turn' } }))
        await preStepStarted
        const taskMessage = createUserMessage({ content: [{ type: 'text', text: 'Persisted task brief' }],
          source: { kind: 'user', rpcId: requestId } })
        let queued!: () => void
        const taskQueued = new Promise<void>(resolve => { queued = resolve })
        const removeQueueListener = ctx.on('session/event', ((session, event) => {
          if (String(session.id) === String(sessionId) && event.type === 'agent/inbox/spliced'
            && event.data.inserted.some(message => message.id === taskMessage.id)) queued()
        }) as never)
        handle.agent.followup(taskMessage)
        await taskQueued
        removeQueueListener()
        if (mode.endsWith('-replay')) {
          await disposeHost()
          disposeHost = undefined
        }
        if (mode.startsWith('queued-edit')) {
          const replacement = createUserMessage({ content: [{ type: 'text', text: 'Edited task brief' }],
            source: { kind: 'user', rpcId: requestId } })
          expect(handle.agent.inbox.replace(taskMessage.id, replacement)).toBe(true)
          expect(handle.agent.inbox.nextTurn.some(message => message.id === replacement.id)).toBe(true)
        } else {
          expect(handle.agent.inbox.remove(taskMessage.id)).toBe(true)
          handle.agent.steer(taskMessage)
          expect(handle.agent.inbox.nextStep.some(message => message.id === taskMessage.id)).toBe(true)
        }
        if (mode.endsWith('-replay')) disposeHost = await mountWatchdogTasks(ctx as never, store, new GovernanceAccess())
        const movedResponse = await postUncertain()
        expect(movedResponse.status).toBe(200)
        expect(await movedResponse.json()).toEqual({ outcome: 'uncertain' })
        await disposeHost?.()
        disposeHost = undefined
        handle.agent.cancel({ kind: 'user' })
      } else {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Persisted task brief' }],
          source: { kind: 'user', rpcId: requestId } }))
      }
      if (mode === 'persist-pending-remount') {
        // The backend write gate is installed before dispatch; the first real Session batch now blocks.
        await persistenceBatchReady
        const readsBeforeRemount = openReadCount
        disposeHost = await mountWatchdogTasks(ctx as never, store, new GovernanceAccess())
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        expect(openReadCount).toBe(readsBeforeRemount)
        releasePersistence()
        releasePreStep()
      }
      if (mode === 'mid-flight-remount' || mode === 'same-turn-pending') {
        await preStepStarted
        disposeHost = await mountWatchdogTasks(ctx as never, store, new GovernanceAccess())
        expect((await postUncertain()).status).toBe(200)
        if (mode === 'same-turn-pending') expect((await postUncertainFor(secondTaskId, secondRequestId)).status).toBe(200)
        const pausedHandle = await ctx.sessionPersistence.open(sessionId, 'read')
        const pausedLog = await pausedHandle.read()
        await pausedHandle.close()
        expect(pausedLog.events.some(event => event.type === 'turn/start')).toBe(true)
        expect(pausedLog.events.some(event => event.type === 'agent/inbox/spliced' && event.data.removedCount === 1)).toBe(true)
        expect(pausedLog.events.some(event => event.type === 'user/message')).toBe(false)
        releasePreStep()
      }
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      if (mode === 'queued-cancel-replay') disposeHost = await mountWatchdogTasks(ctx as never, store, new GovernanceAccess())
      if (mode === 'observer-write-fail') {
        store.recordObservedTaskExecutionOutcome = originalRecordObserved
        await disposeHost?.()
        disposeHost = undefined
      }
      const durable = await ctx.sessionPersistence.open(sessionId, 'read')
      const { events } = await durable.read()
      await durable.close()
      expect(events.some(event => event.type === 'user/message')).toBe(false)
      expect(events.some(event => event.type === 'agent/inbox/spliced' && event.data.removedCount === 1)).toBe(true)
      const expectedTurnReason = mode === 'assembly-error' ? 'error' : mode === 'observer-write-fail' ? 'blocked'
        : mode.startsWith('queued-cancel') || mode.startsWith('queued-steer') || mode.startsWith('queued-edit') ? 'aborted' : mode === 'noop-empty' ? 'completed'
        : mode === 'mid-flight-remount' || mode === 'same-turn-pending' || mode === 'persist-pending-remount' ? 'blocked' : mode
      expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: expectedTurnReason } } })

      if (mode !== 'mid-flight-remount' && mode !== 'same-turn-pending' && mode !== 'persist-pending-remount' && mode !== 'noop-empty'
        && mode !== 'queued-cancel-live' && mode !== 'queued-cancel-replay'
        && mode !== 'queued-steer-live' && mode !== 'queued-steer-replay'
        && mode !== 'queued-edit-live' && mode !== 'queued-edit-replay') {
        disposeHost = await mountWatchdogTasks(ctx as never, store, new GovernanceAccess())
      }
      const expectedOutcome = mode === 'noop-empty' || mode.startsWith('queued-steer') || mode.startsWith('queued-edit') ? 'uncertain' : 'failed'
      await expect.poll(() => store.responsibility({ operation: 'task.dispatch' }).records
        .filter(record => record.entityId === taskId).at(-1)?.outcome, { timeout: 1000 }).toBe(expectedOutcome)
      if (!mode.startsWith('queued-steer') && !mode.startsWith('queued-edit')) {
        const recoveredResponse = await postUncertain()
        expect(recoveredResponse.status).toBe(200)
        expect(await recoveredResponse.json()).toEqual({ outcome: expectedOutcome })
      }
      const records = store.responsibility({ operation: 'task.dispatch' }).records.filter(record => record.entityId === taskId)
      expect(records.map(record => record.outcome)).toEqual(mode === 'noop-empty' || mode.startsWith('queued-steer') || mode.startsWith('queued-edit')
        ? ['uncertain'] : ['uncertain', 'failed'])
      if (reasonCode) expect(records.at(-1)?.reasonCode).toBe(reasonCode)
      if (mode === 'same-turn-pending') {
        expect(store.responsibility({ operation: 'task.dispatch' }).records
          .filter(record => record.entityId === secondTaskId).map(record => record.outcome)).toEqual(['uncertain'])
      }
    } finally {
      releasePersistenceForCleanup?.()
      releasePreStepForCleanup?.()
      restorePersistenceSpy?.()
      restoreOpenSpy?.()
      await disposeHost?.()
      await disposeAgent?.()
      await ctx.fiber.dispose()
      store.close()
    }
  })
})
