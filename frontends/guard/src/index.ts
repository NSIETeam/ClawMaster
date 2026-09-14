/**
 * ClawMaster Guard: a deterministic review layer over destructive tool calls.
 *
 * It mounts on the harness's `tools/pre-execute` waterfall, the same interception point the
 * Claude Code and Codex hook bridges use, and answers one question before a call runs: does this
 * action destroy something the user did not ask to destroy? Nothing here trusts the model's stated
 * intent, and nothing here approves a destructive action on the model's behalf — critical patterns
 * are refused outright and everything else destructive is raised for the user's own approval.
 *
 * The layer is deliberately fail-open on its own errors: a guard that breaks the agent because it
 * could not parse a command is a worse outcome than the call it failed to classify, so a throwing
 * review logs and delegates.
 * @module @clawmaster/dsh-guard
 */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { parseOptions, reviewCall, workdirOf, type GuardOptions } from './policy.ts';

export const name = 'clawmaster-guard';

/** The host services this plugin uses; declared structurally so the module stays dependency-light. */
export interface GuardHostContext {
  /** Subscribe to a harness waterfall event. */
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): void;
  /** Host logger. */
  logger: { info(message: string): void; warn(message: string): void };
}

/** Review one pending call and return the decision, or undefined to let the pipeline continue. */
export function reviewExecution(
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
  options: GuardOptions,
  context: { home: string; cwd: string },
): PreToolDecision | undefined {
  return reviewCall({ name: exec.name, arguments: exec.arguments }, options, context).decision;
}

/**
 * Mount the guard.
 * @param ctx - Host context.
 * @param config - Optional `{ mode, shellTools, denyPaths, allowPaths }`.
 */
export function apply(ctx: GuardHostContext, config: unknown = {}): void {
  const options = parseOptions(config);
  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision: PreToolDecision | undefined;
    try {
      decision = reviewExecution(exec, options, {
        home: homedir(),
        cwd: workdirOf({ name: exec.name, arguments: exec.arguments }) ?? process.cwd(),
      });
    } catch (error) {
      // A guard bug must not become a broken agent: report it and let the call through.
      ctx.logger.warn(`clawmaster-guard: review failed, delegating: ${String(error)}`);
      return next();
    }
    if (decision === undefined) return next();
    ctx.logger.info(`clawmaster-guard: ${decision.kind} ${exec.name}${decision.kind === 'allow' ? '' : ` — ${decision.reason}`}`);
    return decision;
  });
  ctx.logger.info(`clawmaster-guard: mounted (mode ${options.mode})`);
}
