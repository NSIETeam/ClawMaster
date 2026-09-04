/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

export interface NonOverlappingPollOptions {
  runImmediately?: boolean;
  onError?: (error: unknown) => void;
}

/** Schedule the next async poll only after the current operation settles. */
export function startNonOverlappingPoll(
  task: () => void | Promise<void>,
  intervalMs: number,
  options: NonOverlappingPollOptions = {},
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('poll interval must be positive');
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (!stopped) timer = setTimeout(() => void run(), intervalMs);
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await task();
    } catch (error) {
      options.onError?.(error);
    } finally {
      schedule();
    }
  };
  if (options.runImmediately === false) schedule();
  else void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
