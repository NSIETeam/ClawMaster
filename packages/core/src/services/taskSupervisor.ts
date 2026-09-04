/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

export interface SupervisorAttemptContext {
  taskId: string;
  attempt: number;
  failure: unknown;
}

export interface SupervisorDecision {
  action: 'retry' | 'escalate' | 'fail';
  reason: string;
}

export interface TaskSupervisorOptions {
  maxPrimaryAttempts?: number;
  onDecision?: (decision: SupervisorDecision, context: SupervisorAttemptContext) => void;
}

/** Keeps a blocked task moving without silently replaying external side effects. */
export class TaskSupervisor {
  private readonly maxPrimaryAttempts: number;
  private readonly onDecision: NonNullable<TaskSupervisorOptions['onDecision']>;

  constructor(options: TaskSupervisorOptions = {}) {
    this.maxPrimaryAttempts = Math.max(1, Math.floor(options.maxPrimaryAttempts ?? 1));
    this.onDecision = options.onDecision ?? (() => undefined);
  }

  async run<T>(taskId: string, primary: () => Promise<T>, caretaker: (context: SupervisorAttemptContext) => Promise<T>): Promise<T> {
    let attempt = 0;
    while (attempt < this.maxPrimaryAttempts) {
      attempt += 1;
      try {
        return await primary();
      } catch (failure) {
        const context = { taskId, attempt, failure };
        if (attempt < this.maxPrimaryAttempts) {
          this.onDecision({ action: 'retry', reason: 'primary agent failed; retry remains within policy' }, context);
          continue;
        }
        this.onDecision({ action: 'escalate', reason: 'primary agent is blocked; caretaker must re-plan before continuing' }, context);
        return caretaker(context);
      }
    }
    throw new Error('task supervisor exhausted its primary attempt budget');
  }
}
