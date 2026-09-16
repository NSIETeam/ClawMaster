import assert from 'node:assert/strict';
import test from 'node:test';
import { taskAttentionSummary } from '../src/watchdog-task-format.ts';

const task = (overrides = {}) => ({
  id: 'task', status: 'ready', dueAt: null, waitingFor: null, ...overrides,
});

test('attention summary counts overlapping signals once per task', () => {
  const summary = taskAttentionSummary([
    task({ id: 'overdue-and-waiting', dueAt: '2026-01-01T00:00:00.000Z', waitingFor: 'approval' }),
    task({ id: 'review', status: 'awaiting_review', dueAt: '2027-01-01T00:00:00.000Z' }),
    task({ id: 'failed', status: 'failed', dueAt: '2026-01-01T00:00:00.000Z' }),
    task({ id: 'accepted', status: 'accepted', dueAt: '2026-01-01T00:00:00.000Z' }),
  ], Date.parse('2026-09-16T00:00:00.000Z'));
  assert.deepEqual(summary, { total: 4, needsAttention: 3, overdue: 2, waiting: 1, awaitingReview: 1, failed: 1 });
});

test('attention summary is empty for an empty bounded page', () => {
  assert.deepEqual(taskAttentionSummary([]), { total: 0, needsAttention: 0, overdue: 0, waiting: 0, awaitingReview: 0, failed: 0 });
});
