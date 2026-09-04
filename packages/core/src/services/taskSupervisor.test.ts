import { describe, expect, it, vi } from 'vitest';
import { TaskSupervisor } from './taskSupervisor.js';

describe('TaskSupervisor', () => {
  it('hands a blocked task to the caretaker with failure context', async () => {
    const decisions: string[] = [];
    const primary = vi.fn(async () => { throw new Error('blocked'); });
    const caretaker = vi.fn(async (context) => `replanned:${context.taskId}`);
    const result = await new TaskSupervisor({ onDecision: (decision) => decisions.push(decision.action) })
      .run('task-1', primary, caretaker);
    expect(result).toBe('replanned:task-1');
    expect(primary).toHaveBeenCalledOnce();
    expect(caretaker).toHaveBeenCalledOnce();
    expect(decisions).toEqual(['escalate']);
  });

  it('retries only within the configured primary budget', async () => {
    let calls = 0;
    const primary = vi.fn(async () => { calls += 1; if (calls < 2) throw new Error('temporary'); return 'ok'; });
    const caretaker = vi.fn(async () => 'caretaker');
    await expect(new TaskSupervisor({ maxPrimaryAttempts: 2 }).run('task-2', primary, caretaker)).resolves.toBe('ok');
    expect(caretaker).not.toHaveBeenCalled();
  });
});
