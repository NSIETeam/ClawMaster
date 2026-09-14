/**
 * ClawMaster Guard: the review layer ClawMaster runs around an agent's work.
 *
 * It covers the three moments a review can still change the outcome:
 *
 * - **Process** — `tools/pre-execute`, the same interception point the Claude Code and Codex hook
 *   bridges use. Critical destructive patterns are refused outright and every other destructive
 *   action is raised for the user's own approval; with no answerer an `ask` fails closed.
 * - **Result** — `session/event`. At `turn/end` the turn's own events are reduced to facts and
 *   archived into the notes vault as a checkable entry: what ran, on what, and what the turn could
 *   not establish. Nothing is claimed beyond what the events showed.
 * - **Plan** — reserved for the plan-review stage (the `exit_plan_mode` call and the plan text).
 *
 * The layer is deliberately fail-open about its own errors: a reviewer that breaks the agent
 * because it could not parse a command is a worse outcome than the call it failed to classify, so a
 * throwing review logs and delegates.
 * @module @clawmaster/dsh-guard
 */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { parseOptions, planDecision, reviewCall, workdirOf, type GuardOptions } from './policy.ts';
import { composeResultReview } from './review.ts';
import { collectTurn, isReviewable, type ReviewEvent } from './turn-facts.ts';

export const name = 'clawmaster-guard';

/**
 * Context key the notes host publishes its vault access under
 * (`@clawmaster/dsh-notes` → `NOTES_ACCESS_KEY`). The two packages pin the same literal, and the
 * notes suite asserts the published key, so a rename cannot drift silently.
 */
export const NOTES_ACCESS_KEY = 'clawmasterNotes';

/** The vault surface this plugin consumes; declared structurally to avoid a package dependency. */
export interface NotesAccessPort {
  /** Append one composed entry to the day's note. */
  digest(entry: {
    summary: string;
    decisions?: string[];
    evidence?: string[];
    nextSteps?: string[];
    project?: string | undefined;
    date?: string | undefined;
    time?: string | undefined;
  }): Promise<{ id: string; revision: string }>;
}

/** The host services this plugin uses; declared structurally so the module stays dependency-light. */
export interface GuardHostContext {
  /** Subscribe to the tool waterfall that decides a call before it executes. */
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): void;
  /** Subscribe to the session event firehose the result stage reads. */
  on(
    event: 'session/event',
    listener: (session: unknown, event: ReviewEvent) => void,
  ): void;
  /** Read a value another plugin published (the notes vault access). */
  get(name: string): unknown;
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
 * Archive one finished turn through the notes access, if a vault is available.
 * @param ctx - Host context.
 * @param facts - The turn's facts.
 * @param options - Guard configuration.
 */
export async function archiveTurn(
  ctx: Pick<GuardHostContext, 'get' | 'logger'>,
  facts: Parameters<typeof composeResultReview>[0],
  options: GuardOptions,
): Promise<void> {
  if (!isReviewable(facts)) return;
  const access = ctx.get(NOTES_ACCESS_KEY) as NotesAccessPort | undefined;
  if (access === undefined || typeof access.digest !== 'function') {
    ctx.logger.warn('clawmaster-guard: result review skipped — the notes vault is not mounted');
    return;
  }
  const review = composeResultReview(facts);
  const written = await access.digest({
    summary: review.summary,
    evidence: review.evidence,
    nextSteps: review.nextSteps,
    ...options.resultProject !== undefined ? { project: options.resultProject } : {},
  });
  ctx.logger.info(`clawmaster-guard: result review archived to ${written.id}`);
}

/**
 * Mount the guard.
 * @param ctx - Host context.
 * @param config - Optional `{ mode, shellTools, denyPaths, allowPaths, resultReview, resultProject }`.
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
      // The plan stage reviews a submission before the user is asked to accept it; it only decides
      // when it is enforcing, and otherwise records what it found.
      decision ??= planDecision({ name: exec.name, arguments: exec.arguments }, options, ctx.logger);
    } catch (error) {
      // A guard bug must not become a broken agent: report it and let the call through.
      ctx.logger.warn(`clawmaster-guard: review failed, delegating: ${String(error)}`);
      return next();
    }
    if (decision === undefined) return next();
    ctx.logger.info(`clawmaster-guard: ${decision.kind} ${exec.name}${decision.kind === 'allow' ? '' : ` — ${decision.reason}`}`);
    return decision;
  });

  if (options.resultReview === 'archive') {
    // One buffer per session, drained at each turn boundary: a turn's review is composed only from
    // that turn's own events, so a long session never accumulates one unbounded list.
    const pending = new Map<unknown, ReviewEvent[]>();
    ctx.on('session/event', (session, event) => {
      const events = pending.get(session) ?? [];
      events.push(event);
      pending.set(session, events);
      if (event.type !== 'turn/end') return;
      pending.delete(session);
      void archiveTurn(ctx, collectTurn(events), options).catch(error => {
        ctx.logger.warn(`clawmaster-guard: result review failed: ${String(error)}`);
      });
    });
  }

  ctx.logger.info(`clawmaster-guard: mounted (mode ${options.mode}, result review ${options.resultReview})`);
}
