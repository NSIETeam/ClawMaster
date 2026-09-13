/** Live desktop facts and bounded tool dispatch on the existing DSH services. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { z } from 'zod';

/** Deployment budgets apply to Host RSS and overlapping heavy tool bodies. */
export interface RuntimeGovernanceConfig {
  maxRssMiB?: number;
  maxConcurrentHeavyTools?: number;
  heavyToolPatterns?: string[];
}

const MiB = 1024 * 1024;
const RuntimeRecord = z.object({
  schemaVersion: z.literal(1), status: z.literal('ready'), runId: z.string().min(1), hostPid: z.number().int().positive(),
  observedAtUnixMs: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), harnessRoot: z.string(),
  desktopVersion: z.string(), harnessVersion: z.string(), port: z.number().int().min(1).max(65535),
  disabledPlugins: z.array(z.string()),
  buildProvenance: z.object({ mode: z.enum(['release', 'development']), source: z.object({
    gitCommit: z.string(), gitTree: z.string(), dirty: z.boolean(), sourceSha256: z.string(),
  }) }).nullable(),
});

type RuntimeObservation = {
  available: boolean; observedAt: string; reason: string | null;
  identity: null | {
    startedAtUnixMs: number; desktopVersion: string; harnessVersion: string;
    contentSha256: string; harnessRoot: string; hostPid: number; port: number;
    source: null | { gitCommit: string; gitTree: string; dirty: boolean; sourceSha256: string; mode: string };
    disabledPlugins: string[];
  };
};

/**
 * Read the shell's current identity and refuse a stopped or different Host's record.
 * @param path - Desktop-owned state path; absent for a standalone Web Host.
 * @param pid - Host process whose identity must match the record.
 * @param runId - Shell-issued boot identity, independent of operating-system PID reuse.
 * @returns Freshly observed facts; unavailable records never become cached current facts.
 */
export function observeRuntime(path: string | undefined, pid = process.pid, runId = process.env.CLAWMASTER_RUNTIME_RUN_ID): RuntimeObservation {
  const observedAt = new Date().toISOString();
  if (!path) return { available: false, observedAt, reason: 'desktop-state-not-configured', identity: null };
  try {
    const parsed = RuntimeRecord.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success || parsed.data.hostPid !== pid || parsed.data.runId !== runId) {
      return { available: false, observedAt, reason: 'desktop-state-not-current', identity: null };
    }
    const value = parsed.data;
    const source = value.buildProvenance?.source;
    return {
      available: true, observedAt, reason: null, identity: { startedAtUnixMs: value.observedAtUnixMs,
      desktopVersion: value.desktopVersion, harnessVersion: value.harnessVersion,
      contentSha256: value.contentSha256, harnessRoot: value.harnessRoot,
      hostPid: value.hostPid, port: value.port,
      source: source ? { gitCommit: source.gitCommit, gitTree: source.gitTree, dirty: source.dirty,
        sourceSha256: source.sourceSha256, mode: value.buildProvenance!.mode } : null,
      disabledPlugins: value.disabledPlugins,
      },
    };
  } catch {
    // Missing, unreadable or malformed local state is unavailable, never a remembered fallback.
    return { available: false, observedAt, reason: 'desktop-state-unreadable', identity: null };
  }
}

/**
 * Resolve explicit deployment budgets and reject invalid settings at plugin load.
 * @param config - Optional Host RSS, overlap and tool-name selection.
 * @returns Validated budgets and compiled tool-name matchers.
 */
export function resolveRuntimeBudgets(config: RuntimeGovernanceConfig) {
  const maxRssMiB = config.maxRssMiB ?? Math.max(256, Math.min(2048, Math.floor(totalmem() / MiB / 4)));
  const maxConcurrentHeavyTools = config.maxConcurrentHeavyTools ?? 2;
  for (const [key, value] of Object.entries({ maxRssMiB, maxConcurrentHeavyTools })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Runtime ${key} must be a positive safe integer`);
  }
  const heavyToolPatterns = config.heavyToolPatterns ?? ['(^|_)(bash|pwsh|shell|subagent|teams?|workflow)(_|$)', '^csv_process$'];
  if (heavyToolPatterns.length === 0) throw new Error('Runtime heavyToolPatterns must not be empty');
  const patterns = heavyToolPatterns.map(pattern => new RegExp(pattern));
  return { maxRssMiB, maxConcurrentHeavyTools, matches: (name: string) => patterns.some(pattern => pattern.test(name)) };
}

/**
 * Register live facts as logged context and a read-only tool; reject excess heavy dispatch.
 * @param ctx - DSH prompt, tool registry and plugin lifetime.
 * @param config - RSS and concurrency budgets, configurable through the frontend Host row.
 */
export function applyRuntimeGovernance(ctx: Context, config: RuntimeGovernanceConfig = {}): void {
  const limits = resolveRuntimeBudgets(config);
  let activeHeavyTools = 0;
  const observe = () => ({ ...observeRuntime(process.env.CLAWMASTER_RUNTIME_STATE), resources: {
    hostRssMiB: Math.ceil(process.memoryUsage.rss() / MiB),
    maxRssMiB: limits.maxRssMiB, activeHeavyTools, maxConcurrentHeavyTools: limits.maxConcurrentHeavyTools,
  } });
  ctx.systemPrompt.context({
    name: 'clawmaster-current-runtime', order: 100,
    text: () => process.env.CLAWMASTER_RUNTIME_STATE ? [
      'Current ClawMaster runtime observation: ' + JSON.stringify(observe()),
      'Runtime versions, paths, ports, PIDs, permissions and resource measurements are volatile. '
      + 'Treat remembered values as dated history. Use runtime_status and the owning live settings before reporting current facts. '
      + 'Record an as-of timestamp for historical observations; never present a runtime directory as a durable business workspace.',
    ].join('\n') : '',
  });
  ctx.tools.register(defineTool({
    name: 'runtime_status', description: 'Read current ClawMaster desktop identity, source provenance and Host resource budgets with an observation timestamp. No credentials or business data. Remembered runtime facts are historical; call this tool to verify current state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async () => JSON.stringify(observe()),
    presentCall: () => ({ card: 'generic', title: 'Runtime status', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
  }));
  ctx.tools.guard(exec => {
    if (!limits.matches(exec.name)) return;
    if (process.memoryUsage.rss() >= limits.maxRssMiB * MiB) {
      return `ClawMaster Host memory budget reached (${limits.maxRssMiB} MiB). No new heavy operation was started. Let active work finish and inspect runtime_status before retrying.`;
    }
  });
  ctx.on('tools/execute', async (exec, next) => {
    if (!limits.matches(exec.name)) return next();
    if (process.memoryUsage.rss() >= limits.maxRssMiB * MiB) {
      throw new Error(`ClawMaster Host memory budget reached (${limits.maxRssMiB} MiB). No new heavy operation was started.`);
    }
    if (activeHeavyTools >= limits.maxConcurrentHeavyTools) {
      throw new Error(`ClawMaster heavy-operation concurrency budget reached (${limits.maxConcurrentHeavyTools}). Wait for active work to finish before retrying.`);
    }
    activeHeavyTools += 1;
    try { return await next(); }
    finally { activeHeavyTools -= 1; }
  });
}
