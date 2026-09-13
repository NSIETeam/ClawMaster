import { memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { TurnProcessActivity } from '../contract/turn-process.ts'
import css from './TurnProcessNodeView.module.css'

/**
 * Compose the running row: the working label, then the newest folded action so
 * a reader can tell the Turn is advancing without expanding the disclosure.
 * @param activity - newest folded process evidence, or null when none is readable.
 * @param t - conversation locale seat.
 * @returns the running disclosure label.
 */
function runningLabel(
  activity: TurnProcessActivity | null,
  t: ChatNodeViewProps<'turn-process'>['t'],
): string {
  const working = t('message.turnProcess.working')
  if (activity === null) return working
  const joined = `${working}${t('message.turnProcess.separator')}`
  if (activity.kind === 'tool') {
    return activity.name === null
      ? `${joined}${t('message.turnProcess.workingTool')}`
      : `${joined}${t('message.turnProcess.workingToolNamed', { name: activity.name })}`
  }
  if (activity.kind === 'context') return `${joined}${t('message.turnProcess.workingContext')}`
  if (activity.kind === 'reasoning') return `${joined}${t('message.turnProcess.workingReasoning')}`
  return `${joined}${t('message.turnProcess.workingMessage')}`
}

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t,
}: ChatNodeViewProps<'turn-process'>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  if (!turnProcess.foldable) return null
  const open = turnProcess.open
  const running = turnProcess.running
  const labels: string[] = []
  if (node.data.toolCallCount > 0) {
    labels.push(t(
      node.data.toolCallCount === 1
        ? 'message.turnProcess.toolCalls.one'
        : 'message.turnProcess.toolCalls.other',
      { count: node.data.toolCallCount },
    ))
  }
  if (node.data.messageCount > 0) {
    labels.push(t(
      node.data.messageCount === 1
        ? 'message.turnProcess.messages.one'
        : 'message.turnProcess.messages.other',
      { count: node.data.messageCount },
    ))
  }
  if (node.data.subagentCount > 0) {
    labels.push(t(
      node.data.subagentCount === 1
        ? 'message.turnProcess.subagents.one'
        : 'message.turnProcess.subagents.other',
      { count: node.data.subagentCount },
    ))
  }
  const label = running
    ? runningLabel(turnProcess.activity, t)
    : labels.length === 0
      ? t('message.turnProcess.thoughtForAWhile')
      : labels.join(t('message.turnProcess.separator'))
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-state={running ? 'running' : 'ok'}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      aria-busy={running || undefined}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        turnProcess.setOpen(!open)
      }}
    >
      <span className={css.label}>{label}</span>
      <IconChevronDownOutline14 className={css.chevron} />
    </button>
  )
})
