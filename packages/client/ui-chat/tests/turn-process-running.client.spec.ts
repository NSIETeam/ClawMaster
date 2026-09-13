import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatLocationNodeIndex, ChatNodeStore } from '../src/client/contract/snapshot.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../src/client/contract/turn-process.ts'
import { ChatTurnProcessProjector } from '../src/client/conversation-nodes/turn-process-presentation.ts'

/**
 * The running Turn-process window is what makes a live Turn collapse into one
 * row instead of streaming every thinking block, Tool row and injection row.
 * These cases pin the projected facts that the Chat seat consumes.
 */

interface StepStub {
  readonly step: number
  readonly status: 'open' | 'closed'
}

interface TurnStub {
  readonly turn: number
  readonly status: 'running' | 'closed'
  readonly steps: readonly StepStub[]
}

interface NodeSpec {
  readonly key: string
  readonly kind: string
  readonly anchorSeq: number
  readonly data?: unknown
}

function turnNode(spec: NodeSpec, turn: TurnStub): ChatNode {
  return {
    key: spec.key,
    kind: spec.kind,
    anchorSeq: spec.anchorSeq,
    target: 'chat',
    visibility: 'visible',
    data: spec.data ?? {},
    location: { kind: 'turn', turn },
  } as unknown as ChatNode
}

function index(specs: readonly NodeSpec[], turn: TurnStub): {
  locations: ChatLocationNodeIndex
  nodes: ChatNodeStore
} {
  const byKey = new Map(specs.map(spec => [spec.key, turnNode(spec, turn)]))
  const order = specs.map(spec => spec.key)
  return {
    locations: {
      getTurn: () => order,
      getStep: () => order,
    } as unknown as ChatLocationNodeIndex,
    nodes: {
      get: (key: string) => byKey.get(key),
    } as unknown as ChatNodeStore,
  }
}

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turn: 1,
    controlAnchorSeq: 3,
    processStartSeq: 3,
    answerAnchorSeq: null,
    answerStep: null,
    inlineReasoning: false,
    messageCount: 0,
    toolCallCount: 1,
    subagentCount: 0,
    ...overrides,
  }
}

function runningCall(name: string): unknown {
  return { root: { callId: 'call-1', name, argsRaw: '', turn: 1, step: 1, time: 0, subCalls: [] } }
}

function settledCall(name: string | null): unknown {
  return {
    root: {
      kind: 'tool-result',
      seq: 5,
      time: 0,
      callId: 'call-1',
      call: name === null ? null : { name, argsRaw: '' },
      callTime: 0,
      content: [],
      isError: false,
      subCalls: [],
    },
  }
}

function assistantStep(step: number, blocks: readonly unknown[]): unknown {
  return { status: 'running', turn: 1, step, blocks, time: 0 }
}

function project(specs: readonly NodeSpec[], turn: TurnStub) {
  const projector = new ChatTurnProcessProjector()
  const { locations, nodes } = index(specs, turn)
  projector.replace(specs.map(entry => entry.key), locations, nodes)
  return projector.get(turnNode(specs[0]!, turn))
}

describe('running Turn process window', () => {
  it('folds a live Turn and keeps the streaming answer out of the fold', () => {
    const turn: TurnStub = { turn: 1, status: 'running', steps: [{ step: 1, status: 'open' }] }
    const presentation = project([
      { key: 'prompt', kind: 'system-prompt', anchorSeq: 1, data: { text: 'rules' } },
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: runningCall('notes_query') },
      { key: 'answer', kind: 'assistant-step', anchorSeq: 7, data: assistantStep(1, []) },
    ], turn)

    expect(presentation).toBeDefined()
    expect(presentation?.running).toBe(true)
    expect(presentation?.turnClosed).toBe(false)
    expect(presentation?.liveAnswerKey).toBe('answer')
    expect(presentation?.activity).toEqual({ kind: 'tool', name: 'notes_query' })
  })

  it('folds an earlier step once the Turn moved on to the step it is streaming', () => {
    const turn: TurnStub = {
      turn: 1,
      status: 'running',
      steps: [{ step: 1, status: 'closed' }, { step: 2, status: 'open' }],
    }
    // The in-flight step has no node yet: it still renders as the partial tail.
    const presentation = project([
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      {
        key: 'earlier',
        kind: 'assistant-step',
        anchorSeq: 5,
        data: assistantStep(1, [{ kind: 'text', text: 'reading the seat' }]),
      },
    ], turn)

    expect(presentation?.liveAnswerKey).toBeNull()
    expect(presentation?.activity).toEqual({ kind: 'message' })
  })

  it('names an injected context as the running action', () => {
    const turn: TurnStub = { turn: 1, status: 'running', steps: [{ step: 1, status: 'open' }] }
    const presentation = project([
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: runningCall('bash') },
      { key: 'context', kind: 'context', anchorSeq: 6, data: {} },
      { key: 'answer', kind: 'assistant-step', anchorSeq: 7, data: assistantStep(1, []) },
    ], turn)

    expect(presentation?.activity).toEqual({ kind: 'context' })
  })

  it('reads a folded earlier step as replying when it carries text', () => {
    const turn: TurnStub = {
      turn: 1,
      status: 'running',
      steps: [{ step: 1, status: 'closed' }, { step: 2, status: 'open' }],
    }
    const presentation = project([
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      {
        key: 'earlier',
        kind: 'assistant-step',
        anchorSeq: 5,
        data: assistantStep(1, [{ kind: 'text', text: 'reading the seat' }]),
      },
      { key: 'answer', kind: 'assistant-step', anchorSeq: 7, data: assistantStep(2, []) },
    ], turn)

    expect(presentation?.liveAnswerKey).toBe('answer')
    expect(presentation?.activity).toEqual({ kind: 'message' })
  })

  it('reads a settled Tool row name from its backfilled call head', () => {
    const turn: TurnStub = { turn: 1, status: 'running', steps: [{ step: 1, status: 'open' }] }
    const named = project([
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: settledCall('read_file') },
      { key: 'answer', kind: 'assistant-step', anchorSeq: 7, data: assistantStep(1, []) },
    ], turn)
    expect(named?.activity).toEqual({ kind: 'tool', name: 'read_file' })

    const truncated = project([
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: settledCall(null) },
      { key: 'answer', kind: 'assistant-step', anchorSeq: 7, data: assistantStep(1, []) },
    ], turn)
    expect(truncated?.activity).toEqual({ kind: 'tool', name: null })
  })

  it('publishes no action and no live answer once the Turn closes', () => {
    const turn: TurnStub = {
      turn: 1,
      status: 'closed',
      steps: [{ step: 1, status: 'closed' }, { step: 2, status: 'closed' }],
    }
    const presentation = project([
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec({ answerAnchorSeq: 9, answerStep: 2 }) },
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: runningCall('notes_query') },
      { key: 'answer', kind: 'assistant-step', anchorSeq: 9, data: assistantStep(2, [{ kind: 'text', text: 'done' }]) },
    ], turn)

    expect(presentation?.running).toBe(false)
    expect(presentation?.turnClosed).toBe(true)
    expect(presentation?.liveAnswerKey).toBeNull()
    expect(presentation?.activity).toBeNull()
  })

  it('reports a change when only the running action moves', () => {
    const turn: TurnStub = { turn: 1, status: 'running', steps: [{ step: 1, status: 'open' }] }
    const first = [
      { key: 'control', kind: 'turn-process', anchorSeq: 3, data: spec() },
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: runningCall('notes_query') },
    ]
    const { locations, nodes } = index(first, turn)
    const projector = new ChatTurnProcessProjector()
    projector.replace(first.map(entry => entry.key), locations, nodes)

    const second = [
      first[0]!,
      { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: runningCall('bash') },
    ]
    const next = index(second, turn)
    const changed = projector.update(new Set([1]), next.locations, next.nodes)

    expect([...changed]).toEqual([1])
    expect(projector.get(turnNode(second[0]!, turn))?.activity).toEqual({ kind: 'tool', name: 'bash' })
  })

  it('folds a system prompt and an injected context like any other process row', () => {
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has('system-prompt')).toBe(false)
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has('context')).toBe(false)
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has('tool-call')).toBe(false)
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has('user')).toBe(true)
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has('turn-tail')).toBe(true)
  })
})
