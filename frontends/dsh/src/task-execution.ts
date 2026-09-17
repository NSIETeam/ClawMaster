/** Build the complete task brief sent to its selected DSH Session. */
import type { ProductLocale } from './locales/frontend.ts';
import type { SessionRequestId } from './services.ts';
import type { TaskRecord } from './watchdog-task-format.ts';

interface TaskSessionSubmissionService {
  beginSubmission(input: { mode: 'queue'; text: string; attachments: readonly [] }): { requestId: SessionRequestId; abandon(): void };
  prompt(content: { type: 'text'; text: string }[], mode: 'queue', signal?: AbortSignal,
    requestId?: SessionRequestId): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
}

/** One DSH Session submission that retains its identity until task persistence confirms it. */
export interface PreparedTaskExecution {
  requestId: SessionRequestId;
  abandon(): void;
  submit(task: TaskRecord, locale: ProductLocale, recordOutcome: RecordTaskExecutionOutcome, signal: AbortSignal): Promise<void>;
}

/** Durable DSH admission fact returned by the responsibility ledger. */
/** Record a client-observed admission as uncertain; only a Host observer can confirm DSH acceptance. */
export type RecordTaskExecutionOutcome = (task: TaskRecord) => Promise<void | 'uncertain' | 'succeeded' | 'failed'>;

/**
 * Include the saved responsibility and acceptance fields in the model-visible Session request.
 * @param task Persisted business task with its execution Session and request identity.
 * @param locale Product language for instruction labels.
 * @returns The task brief submitted through DSH Session prompt.
 */
export function taskExecutionPrompt(task: TaskRecord, locale: ProductLocale): string {
  const labels = locale === 'zh-CN'
    ? { goal: '目标', scope: '范围与资料', owner: '负责人', deadline: '期限', risk: '风险', criteria: '验收标准' }
    : { goal: 'Goal', scope: 'Scope and source material', owner: 'Owner', deadline: 'Deadline', risk: 'Risk', criteria: 'Acceptance criteria' };
  const owner = task.owner.kind === 'local' ? task.owner.label : task.owner.id;
  const deadline = task.dueAt ? `${task.dueAt} (${task.timezone})` : (locale === 'zh-CN' ? '未设置' : 'Not set');
  return [
    `${labels.goal}: ${task.goal}`, `${labels.scope}: ${task.scope}`, `${labels.owner}: ${owner}`,
    `${labels.deadline}: ${deadline}`, `${labels.risk}: ${task.risk}`, `${labels.criteria}:`,
    ...task.checklist.map((item, index) => `${index + 1}. ${item.description}`),
    locale === 'zh-CN'
      ? '请按范围执行任务，为每项验收标准提供可核验的结果证据。不要自行标记业务验收通过；遇到超出范围、需要授权或无法验证的步骤时先说明并等待。'
      : 'Perform the task within scope and return verifiable result evidence for every acceptance criterion. Do not mark the business task accepted. Explain and wait when a step is out of scope, requires authorization or cannot be verified.',
  ].join('\n');
}

/**
 * Register the visible Session echo before persisting and sending its task command.
 * @param task Business definition being started.
 * @param locale Product language for prompt instructions.
 * @param session Selected DSH Session submission service.
 * @returns A stable request identity, abandonment action and prompt operation.
 */
export function prepareTaskExecution(task: TaskRecord, locale: ProductLocale, session: TaskSessionSubmissionService): PreparedTaskExecution {
  const text = taskExecutionPrompt(task, locale);
  const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] });
  return {
    requestId: submission.requestId,
    abandon: submission.abandon,
    async submit(taskRecord, _productLocale, recordOutcome, signal) {
      if (taskRecord.execution?.requestId !== submission.requestId) throw new Error('Task execution request identity changed before dispatch.');
      const recorded = await recordOutcome(taskRecord);
      if (recorded !== undefined && recorded !== 'uncertain') return;
      const result = await session.prompt([{ type: 'text', text }], 'queue', signal, submission.requestId);
      if (!result.ok) throw new Error(result.error.message);
    },
  };
}

/**
 * Retry a persisted task submission after a reload, using its original Session request identity.
 * @param task Persisted in-progress task with its execution link.
 * @param locale Product language for prompt instructions.
 * @param session Selected DSH Session submission service.
 * @param signal Plugin lifetime cancellation signal.
 * @returns Nothing after Session accepts the prompt.
 */
export async function retryTaskExecution(task: TaskRecord, session: TaskSessionSubmissionService,
  recordOutcome: RecordTaskExecutionOutcome, signal: AbortSignal): Promise<void> {
  if (!task.execution) throw new Error('Task execution has no persisted request identity.');
  const recorded = await recordOutcome(task);
  if (recorded !== undefined && recorded !== 'uncertain') return;
  const result = await session.prompt([{ type: 'text', text: taskExecutionPrompt(task, task.execution.locale) }], 'queue', signal,
    task.execution.requestId as SessionRequestId);
  if (!result.ok) throw new Error(result.error.message);
}
