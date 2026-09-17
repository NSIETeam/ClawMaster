import assert from 'node:assert/strict';
import test from 'node:test';
import { taskRecordSchema } from '../src/watchdog-task-format.ts';
import { prepareTaskExecution, retryTaskExecution, taskExecutionPrompt } from '../src/task-execution.ts';

const task = taskRecordSchema.parse({
  id: 'task-1', organizationId: 'local', revision: 3, status: 'in_progress', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  goal: '检查客户跟进风险', scope: '只检查选定的客户记录', owner: { kind: 'local', label: '客户经理' }, dueAt: '2026-09-18T09:00:00.000Z',
  timezone: 'Asia/Shanghai', risk: 'medium', checklist: [{ id: 'report', description: '提供客户跟进记录和待办报告' }],
  source: 'new', sessionIds: ['session-1'], execution: { sessionId: 'session-1', requestId: 'request-1' }, waitingFor: null,
  evidence: [], completedCriteria: [], submittedBy: null, lastReview: null,
});

test('task execution brief includes the persisted target, scope, responsibility, deadline, risk and every criterion', () => {
  const prompt = taskExecutionPrompt(task, 'zh-CN');
  for (const value of ['检查客户跟进风险', '只检查选定的客户记录', '客户经理', 'Asia/Shanghai', 'medium', '提供客户跟进记录和待办报告', '不要自行标记业务验收通过']) {
    assert.ok(prompt.includes(value), `task prompt must include ${value}`);
  }
});

test('legacy task records receive an empty execution link until a human explicitly starts them', () => {
  const { execution: _ignored, ...legacy } = task;
  assert.equal(taskRecordSchema.parse(legacy).execution, null);
});

test('task start records only a browser-observed uncertainty before DSH prompt', async () => {
  const calls = [];
  const session = {
    beginSubmission(input) { calls.push(['begin', input]); return { requestId: 'request-1', abandon() {} }; },
    async prompt(content, mode, signal, requestId) { calls.push(['prompt', content, mode, signal.aborted, requestId]); return { ok: true, value: {} }; },
  };
  const prepared = prepareTaskExecution(task, 'zh-CN', session);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'begin');
  assert.equal(calls[0][1].text, taskExecutionPrompt(task, 'zh-CN'));
  const signal = new AbortController().signal;
  await prepared.submit(task, 'zh-CN', async () => { calls.push(['outcome', 'uncertain']); }, signal);
  assert.deepEqual(calls.slice(1), [
    ['outcome', 'uncertain'],
    ['prompt', [{ type: 'text', text: calls[0][1].text }], 'queue', false, 'request-1'],
  ]);
});

test('retry after reload resends the saved task brief with its persisted DSH request identity', async () => {
  const calls = [];
  const session = { beginSubmission() { throw new Error('A reload retry reuses the saved identity.'); },
    async prompt(content, mode, signal, requestId) { calls.push([content[0].text, mode, requestId]); return { ok: true, value: {} }; } };
  await retryTaskExecution(task, session, async () => {}, new AbortController().signal);
  assert.deepEqual(calls, [[taskExecutionPrompt(task, 'en-US'), 'queue', 'request-1']]);
});

test('retry after durable Session replay does not dispatch a terminal request again', async () => {
  let prompts = 0;
  const session = { beginSubmission() { throw new Error('A replay uses the durable request identity.'); },
    async prompt() { prompts++; return { ok: true, value: {} }; } };
  await retryTaskExecution(task, session, async () => 'failed', new AbortController().signal);
  await retryTaskExecution(task, session, async () => 'succeeded', new AbortController().signal);
  assert.equal(prompts, 0);
});

test('an explicit DSH refusal remains retryable with the same request identity', async () => {
  let prompts = 0;
  const session = { beginSubmission() { return { requestId: 'request-1', abandon() {} }; },
    async prompt() { prompts++; return { ok: false, error: { code: 'session/agent-busy', message: 'Session rejected the request.' } }; } };
  const record = async () => {};
  const prepared = prepareTaskExecution(task, 'en-US', session);
  await assert.rejects(prepared.submit(task, 'en-US', record, new AbortController().signal), /Session rejected/);
  await assert.rejects(retryTaskExecution(task, session, record, new AbortController().signal), /Session rejected/);
  assert.equal(prompts, 2);
});

test('gateway response loss stays uncertain and a retry repeats the same brief and request id', async () => {
  const calls = [];
  let prompts = 0;
  const session = { async prompt(content, mode, _signal, requestId) {
    calls.push([content[0].text, mode, requestId]);
    prompts++;
    return prompts === 1
      ? { ok: false, error: { code: 'gateway/internal', message: 'carrier lost response' } }
      : { ok: true, value: { accepted: true } };
  } };
  const zhTask = { ...task, execution: { ...task.execution, locale: 'zh-CN' } };
  const prepared = prepareTaskExecution(zhTask, 'zh-CN', { ...session, beginSubmission: () => ({ requestId: 'request-1', abandon() {} }) });
  await assert.rejects(prepared.submit(zhTask, 'zh-CN', async () => {}, new AbortController().signal), /carrier lost response/);
  await retryTaskExecution(zhTask, session, async () => {}, new AbortController().signal);
  assert.deepEqual(calls, [
    [taskExecutionPrompt(zhTask, 'zh-CN'), 'queue', 'request-1'],
    [taskExecutionPrompt(zhTask, 'zh-CN'), 'queue', 'request-1'],
  ]);
});
