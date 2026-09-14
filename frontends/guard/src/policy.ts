/**
 * The decision layer: turns one pending tool call into an allow, an ask, or a denial.
 *
 * Codex's auto-review maps `risk_level × user_authorization` onto allow/deny. The second axis is a
 * judgement call a deterministic guard cannot make, so this layer takes the conservative side of
 * it: anything destructive is raised for approval, and the answerers decide. In a session with no
 * answerer an `ask` resolves to a denial (the harness fails closed), which is exactly the
 * unattended stance the user asked for — a deletion cannot happen because nobody was there to say
 * yes, rather than because the guard guessed.
 * @module @clawmaster/dsh-guard/policy
 */

import type { PreToolDecision } from '@deepseek-ai/dsh-tools';
import { inspectShellCommand, type Finding, type InspectContext } from './classify.ts';

/** Guard configuration; every field has a working default. */
export interface GuardOptions {
  /**
   * `enforce` decides; `observe` only records what it would have decided and lets the call run.
   * Use `observe` to measure the rule set against a real workload before trusting it.
   */
  mode: 'enforce' | 'observe';
  /** Shell tool names whose `command` argument is reviewed. */
  shellTools: readonly string[];
  /** Path prefixes that are always denied, whatever the rules say. */
  denyPaths: readonly string[];
  /** Path prefixes where a high-risk action runs without approval (a scratch or build directory). */
  allowPaths: readonly string[];
}

/** Defaults: enforce, review the shell tools, and deny nothing beyond the rule set. */
export const DEFAULT_OPTIONS: GuardOptions = {
  mode: 'enforce',
  shellTools: ['bash', 'shell', 'run_command', 'exec'],
  denyPaths: [],
  allowPaths: [],
};

/** The decision for one call plus the finding behind it, so a caller can log either. */
export interface Review {
  /** The classifier's verdict. */
  finding: Finding;
  /** `undefined` delegates to the rest of the pipeline (allow). */
  decision: PreToolDecision | undefined;
}

/**
 * Read plugin configuration, accepting a partial object and falling back per field.
 * @param config - Whatever the composition passed as plugin config.
 * @returns Complete options.
 */
export function parseOptions(config: unknown): GuardOptions {
  const source = typeof config === 'object' && config !== null ? config as Record<string, unknown> : {};
  const mode = source['mode'] === 'observe' ? 'observe' : DEFAULT_OPTIONS.mode;
  return {
    mode,
    shellTools: stringList(source['shellTools']) ?? DEFAULT_OPTIONS.shellTools,
    denyPaths: stringList(source['denyPaths']) ?? DEFAULT_OPTIONS.denyPaths,
    allowPaths: stringList(source['allowPaths']) ?? DEFAULT_OPTIONS.allowPaths,
  };
}

/** A configured list of strings, or undefined when the field is absent or unusable. */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return items.length === value.length ? items : undefined;
}

/** The command line a shell tool call would run, when the call is one. */
export function shellCommandOf(call: { name: string; arguments: unknown }, options: GuardOptions): string | undefined {
  if (!options.shellTools.includes(call.name)) return undefined;
  const args = typeof call.arguments === 'object' && call.arguments !== null ? call.arguments as Record<string, unknown> : {};
  const command = args['command'];
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}

/** The working directory a shell tool call declared, when it declared one. */
export function workdirOf(call: { name: string; arguments: unknown }): string | undefined {
  const args = typeof call.arguments === 'object' && call.arguments !== null ? call.arguments as Record<string, unknown> : {};
  const workdir = args['workdir'];
  return typeof workdir === 'string' && workdir.startsWith('/') ? workdir : undefined;
}

/**
 * Review one pending tool call.
 * @param call - Tool name and parsed arguments.
 * @param options - Guard configuration.
 * @param context - Home directory and the directory the call runs in.
 * @returns The finding and, when the guard itself decides, the decision for the pipeline.
 */
export function reviewCall(
  call: { name: string; arguments: unknown },
  options: GuardOptions,
  context: InspectContext,
): Review {
  const command = shellCommandOf(call, options);
  if (command === undefined) {
    return { finding: { risk: 'low', code: 'unreviewed-tool', reason: 'Not a reviewed shell call.', targets: ['-'] }, decision: undefined };
  }
  const finding = inspectShellCommand(command, context);
  if (options.mode === 'observe') return { finding, decision: undefined };
  return { finding, decision: decide(finding, options) };
}

/** Map a finding onto a pipeline decision: critical denies, high asks, everything else passes. */
function decide(finding: Finding, options: GuardOptions): PreToolDecision | undefined {
  const named = finding.targets.filter(target => target !== '-');
  const denied = named.filter(target => options.denyPaths.some(prefix => target === prefix || target.startsWith(`${prefix.replace(/\/+$/, '')}/`)));
  if (denied.length > 0) {
    return { kind: 'deny', reason: reason(finding, `Denied by configuration: ${denied.join(', ')} sits under a protected path.`) };
  }
  if (finding.risk === 'critical') {
    return { kind: 'deny', reason: reason(finding, 'This command can cause irreversible damage beyond this task, so the guard refuses it outright.') };
  }
  if (finding.risk === 'high') {
    const allowed = named.length > 0 && named.every(target => options.allowPaths.some(prefix => target === prefix || target.startsWith(`${prefix.replace(/\/+$/, '')}/`)));
    if (allowed) return undefined;
    return { kind: 'ask', reason: reason(finding, 'Destructive actions need the user\'s own approval; the guard never grants one on the model\'s behalf.') };
  }
  return undefined;
}

/** Compose the model- and user-facing explanation: code, why it fired, targets, and what to do next. */
function reason(finding: Finding, outcome: string): string {
  const targets = finding.targets.filter(target => target !== '-');
  const scope = targets.length > 0 ? ` Target: ${targets.join(', ')}.` : '';
  return `ClawMaster Guard ${finding.code} (${finding.risk}): ${finding.reason}${scope} ${outcome}`;
}
