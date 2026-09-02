/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNonOverlappingPoll } from './nonOverlappingPoll.js';

afterEach(() => vi.useRealTimers());

describe('startNonOverlappingPoll', () => {
  it('never overlaps a slow operation and stops after an in-flight run', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startNonOverlappingPoll(task, 1_000);
    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('reports errors and continues on the next bounded delay', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const stop = startNonOverlappingPoll(task, 500, { onError });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});
