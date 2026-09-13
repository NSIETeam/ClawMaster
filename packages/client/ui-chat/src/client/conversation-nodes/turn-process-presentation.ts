import type { ChatNode } from '../contract/chat-nodes.ts'
import { isSettledTool } from '../contract/chat-nodes.ts'
import type {
  ChatLocationNodeIndex, ChatNodeStore, ChatTurnProcessPresentation,
} from '../contract/snapshot.ts'
import { insideTurnProcessRegion, TURN_PROCESS_INDEPENDENT_KINDS, sameTurnProcessActivity } from '../contract/turn-process.ts'
import type { TurnProcessActivity } from '../contract/turn-process.ts'

function nodeTurn(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

function samePresentation(
  left: ChatTurnProcessPresentation | undefined,
  right: ChatTurnProcessPresentation | undefined,
): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.spec === right.spec
    && left.turn === right.turn
    && left.turnClosed === right.turnClosed
    && left.hasExternalProcess === right.hasExternalProcess
    && left.compactAnswer === right.compactAnswer
    && left.running === right.running
    && left.openingHumanAnchor === right.openingHumanAnchor
    && left.liveAnswerKey === right.liveAnswerKey
    && sameTurnProcessActivity(left.activity, right.activity))
}

/**
 * Describe what one folded process node is doing, for the running row's action
 * line. Kinds without a readable action return null and publish no line.
 * @param node - newest folded process node.
 * @returns the activity, or null when the node carries none.
 */
function activityOf(node: ChatNode | undefined): TurnProcessActivity | null {
  if (node === undefined) return null
  if (node.kind === 'tool-call') {
    const root = node.data.root
    // A settled row keeps its name on the backfilled call head, which is null
    // when window truncation left the call itself outside the window.
    return { kind: 'tool', name: isSettledTool(root) ? root.call?.name ?? null : root.name }
  }
  if (node.kind === 'context') return { kind: 'context' }
  if (node.kind !== 'assistant-step') return null
  const blocks = node.data.blocks
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block === undefined) continue
    if (block.kind === 'reasoning' && block.text.trim() !== '') return { kind: 'reasoning' }
    if (block.kind === 'text' && block.text.trim() !== '') return { kind: 'message' }
  }
  return null
}

function derivePresentation(
  turn: number,
  locations: ChatLocationNodeIndex,
  nodes: ChatNodeStore,
): ChatTurnProcessPresentation | undefined {
  const keys = locations.getTurn(turn)
  const control = keys
    .map(key => nodes.get(key) as ChatNode | undefined)
    .find((node): node is ChatNode<'turn-process'> => node?.kind === 'turn-process')
  if (control === undefined) return undefined

  const spec = control.data
  const location = control.location
  if (location.kind !== 'turn' && location.kind !== 'step') return undefined
  let openingHumanAnchor: number | undefined
  for (const key of keys) {
    const node = nodes.get(key) as ChatNode | undefined
    if ((node?.kind === 'user' || node?.kind === 'steering')
      && node.anchorSeq < spec.controlAnchorSeq) {
      openingHumanAnchor = Math.min(openingHumanAnchor ?? node.anchorSeq, node.anchorSeq)
    }
  }

  const running = location.turn.status !== 'closed'
  const members: ChatNode[] = []
  let hasExternalProcess = false
  let compactAnswer = true
  for (const key of keys) {
    const node = nodes.get(key) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-process') continue
    if ((node.kind === 'user' || node.kind === 'steering')
      && (openingHumanAnchor === undefined || node.anchorSeq > openingHumanAnchor)
      && (spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq)) {
      compactAnswer = false
    }
    if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)
      || !insideTurnProcessRegion(node.anchorSeq, spec.processStartSeq, openingHumanAnchor)
      || (spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq)) continue
    if (node.kind !== 'assistant-step' || spec.answerStep === null || node.data.step !== spec.answerStep) {
      hasExternalProcess = true
    }
    members.push(node)
  }
  // While the Turn runs, only its latest step can be the answer in progress: a
  // node for an earlier step has already been folded away, and the in-flight
  // step often has no node yet because it still renders as the partial tail.
  let liveAnswer: ChatNode | undefined
  if (running) {
    const latestStep = location.turn.steps.at(-1)
    if (latestStep !== undefined) {
      for (const node of members) {
        if (node.kind !== 'assistant-step' || node.data.step !== latestStep.step) continue
        if (liveAnswer === undefined || node.anchorSeq > liveAnswer.anchorSeq) liveAnswer = node
      }
    }
  }
  // The action line describes the newest evidence that actually folded away.
  let newest: ChatNode | undefined
  for (const node of members) {
    if (node === liveAnswer) continue
    if (newest === undefined || node.anchorSeq > newest.anchorSeq) newest = node
  }
  return {
    turn,
    spec,
    turnClosed: !running,
    hasExternalProcess,
    compactAnswer,
    running,
    openingHumanAnchor,
    activity: running ? activityOf(newest) : null,
    liveAnswerKey: liveAnswer?.key ?? null,
  }
}

/** Mutable projection of cross-Node process layout facts by Turn. */
export class ChatTurnProcessProjector {
  private presentations = new Map<number, ChatTurnProcessPresentation>()

  /**
   * Read the retained process presentation for a Node's Turn.
   * @param node - Current Chat Node.
   * @returns The Turn's process presentation, when present.
   */
  get(node: ChatNode | undefined): ChatTurnProcessPresentation | undefined {
    const turn = nodeTurn(node)
    return turn === undefined ? undefined : this.presentations.get(turn)
  }

  /**
   * Replace every projected Turn.
   * @param order - visible Chat Node order.
   * @param locations - current Chat Location index.
   * @param nodes - current Chat Node store.
   * @returns Turns whose process presentation changed.
   */
  replace(
    order: readonly string[],
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): ReadonlySet<number> {
    const turns = new Set<number>()
    for (const key of order) {
      const turn = nodeTurn(nodes.get(key) as ChatNode | undefined)
      if (turn !== undefined) turns.add(turn)
    }
    const changed = new Set<number>()
    for (const turn of new Set([...this.presentations.keys(), ...turns])) {
      if (this.set(turn, turns.has(turn) ? derivePresentation(turn, locations, nodes) : undefined)) {
        changed.add(turn)
      }
    }
    return changed
  }

  /**
   * Recompute selected Turns after incremental Node changes.
   * @param turns - affected Turn numbers.
   * @param locations - current Chat Location index.
   * @param nodes - current Chat Node store.
   * @returns Turns whose process presentation changed.
   */
  update(
    turns: ReadonlySet<number>,
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): ReadonlySet<number> {
    const changed = new Set<number>()
    for (const turn of turns) {
      if (this.set(turn, derivePresentation(turn, locations, nodes))) changed.add(turn)
    }
    return changed
  }

  private set(turn: number, next: ChatTurnProcessPresentation | undefined): boolean {
    const current = this.presentations.get(turn)
    if (samePresentation(current, next)) return false
    if (next === undefined) this.presentations.delete(turn)
    else this.presentations.set(turn, next)
    return true
  }
}
