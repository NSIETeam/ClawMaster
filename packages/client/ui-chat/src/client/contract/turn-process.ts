import type { ChatNode } from './chat-nodes.ts'

/** Current process range and finalized answer boundary derived from one Turn. */
export interface TurnProcessSpec {
  readonly turn: number
  /** Stable control-node anchor source, including currently ineligible evidence. */
  readonly controlAnchorSeq: number
  readonly processStartSeq: number
  readonly answerAnchorSeq: number | null
  readonly answerStep: number | null
  readonly inlineReasoning: boolean
  /** Reply-bearing durable Assistant messages before the final answer. */
  readonly messageCount: number
  /** Durable non-subagent Tool calls recorded by this Turn. */
  readonly toolCallCount: number
  /** Tool calls whose configured name identifies a subagent delegation. */
  readonly subagentCount: number
}

/**
 * Newest folded process evidence, shown beside the running disclosure label so
 * a reader can tell what the Turn is doing without expanding it.
 */
export type TurnProcessActivity =
  | { readonly kind: 'reasoning' }
  | { readonly kind: 'message' }
  | { readonly kind: 'tool'; readonly name: string | null }
  | { readonly kind: 'context' }

/**
 * Compare two running-activity values by their published fields.
 * @param left - previous activity, or null when none is published.
 * @param right - next activity, or null.
 * @returns whether both describe the same activity line.
 */
export function sameTurnProcessActivity(
  left: TurnProcessActivity | null,
  right: TurnProcessActivity | null,
): boolean {
  if (left === right) return true
  if (left === null || right === null || left.kind !== right.kind) return false
  return left.kind !== 'tool' || right.kind !== 'tool' || left.name === right.name
}

const TURN_PROCESS_INDEPENDENT_KIND_LIST = [
  'user',
  'steering',
  'turn-process',
  'turn-error',
  'turn-max-tokens',
  'turn-tail',
] as const satisfies readonly ChatNode['kind'][]

/**
 * Chat Node kinds that remain independent of a Turn's process disclosure.
 * A workspace or system prompt is deliberately absent: it is process evidence
 * like any injected context, so folding a Turn leaves exactly one summary row.
 */
export const TURN_PROCESS_INDEPENDENT_KINDS: ReadonlySet<string> = new Set(
  TURN_PROCESS_INDEPENDENT_KIND_LIST,
)

/**
 * Compare immutable Turn-process specifications by their published fields.
 * @param left - previous specification.
 * @param right - next specification.
 * @returns whether both values describe the same process presentation.
 */
export function sameTurnProcessSpec(left: TurnProcessSpec, right: TurnProcessSpec): boolean {
  return left.turn === right.turn
    && left.controlAnchorSeq === right.controlAnchorSeq
    && left.processStartSeq === right.processStartSeq
    && left.answerAnchorSeq === right.answerAnchorSeq
    && left.answerStep === right.answerStep
    && left.inlineReasoning === right.inlineReasoning
    && left.messageCount === right.messageCount
    && left.toolCallCount === right.toolCallCount
    && left.subagentCount === right.subagentCount
}

/**
 * Recognize the shipped subagent delegation name and its configured variants.
 * Control tools use distinct names such as `send_message` and `list_agents`.
 * @param name - durable Tool-call name.
 * @returns whether the call creates or forks a subagent.
 */
export function isSubagentDelegationTool(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}
