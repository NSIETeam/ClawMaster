import { describe, expect, it, vi } from 'vitest';

import { SubAgent } from './subAgent.js';

describe('SubAgent cancellation', () => {
  it('releases an active tool wait immediately when cancelled', () => {
    vi.useFakeTimers();
    try {
      const agent = Object.create(SubAgent.prototype) as SubAgent & {
        context: { isRunning: boolean; agentId: string };
        executionAbortController: AbortController;
        toolCompletionResolver?: (results: unknown[]) => void;
        toolCompletionTimeoutId?: ReturnType<typeof setTimeout>;
      };
      let released = false;

      agent.context = { isRunning: true, agentId: 'cancel-test' };
      agent.executionAbortController = new AbortController();
      agent.toolCompletionResolver = () => {
        released = true;
      };
      agent.toolCompletionTimeoutId = setTimeout(() => undefined, 60_000);

      agent.cancel();

      expect(agent.executionAbortController.signal.aborted).toBe(true);
      expect(released).toBe(true);
      expect(agent.toolCompletionResolver).toBeUndefined();
      expect(agent.toolCompletionTimeoutId).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
