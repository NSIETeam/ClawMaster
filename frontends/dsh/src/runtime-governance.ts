/** Live desktop facts and bounded tool dispatch on the existing DSH services. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as subprocessLocal from '@deepseek-ai/dsh-subprocess-local';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { totalmem } from 'node:os';
import { z } from 'zod';

/** Deployment budgets apply to Host RSS and overlapping heavy tool bodies. */
export interface RuntimeGovernanceConfig {
  maxRssMiB?: number;
  /** Maximum RSS for the Host and its observed child-process tree. */
  maxProcessTreeRssMiB?: number;
  maxConcurrentHeavyTools?: number;
  heavyToolPatterns?: string[];
}

/** One process-table row used to aggregate a Host's descendant RSS. */
export interface ProcessRssRow { pid: number; parentPid: number; rssKiB: number; }

/** Parse the stable POSIX `ps` columns used by the process-tree observer. */
export function parseProcessRssTable(output: string): ProcessRssRow[] {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) return [];
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const rssKiB = Number(match[3]);
    return [Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid) && parentPid >= 0 && Number.isSafeInteger(rssKiB) && rssKiB >= 0
      ? { pid, parentPid, rssKiB } : undefined].filter((row): row is ProcessRssRow => row !== undefined);
  });
}

/** Observe the RSS of a Host process and all descendants where the platform exposes a parent table.
 * @param rootPid - Host PID whose descendants are included.
 * @param platform - Node platform; unsupported platforms return no observation.
 * @param readTable - Fixed-column process-table reader, injectable for tests.
 * @returns Total and descendant RSS in MiB, or null when the table is unavailable or the root is absent.
 */
export function observeProcessTreeRss(rootPid = process.pid, platform: NodeJS.Platform = process.platform,
  readTable: () => string = () => String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000 }))): { totalRssMiB: number; descendantRssMiB: number } | null {
  if (platform === 'win32' || platform === 'android' || platform === 'freebsd' || platform === 'openbsd' || platform === 'sunos' || platform === 'aix') return null;
  try {
    const rows = parseProcessRssTable(readTable());
    const byParent = new Map<number, ProcessRssRow[]>();
    for (const row of rows) byParent.set(row.parentPid, [...(byParent.get(row.parentPid) ?? []), row]);
    const root = rows.find(row => row.pid === rootPid);
    if (!root) return null;
    const visited = new Set<number>();
    let totalKiB = 0;
    const visit = (row: ProcessRssRow): void => {
      if (visited.has(row.pid)) return;
      visited.add(row.pid);
      totalKiB += row.rssKiB;
      for (const child of byParent.get(row.pid) ?? []) visit(child);
    };
    visit(root);
    const totalRssMiB = Math.ceil(totalKiB / 1024);
    return { totalRssMiB, descendantRssMiB: Math.ceil(Math.max(0, totalKiB - root.rssKiB) / 1024) };
  } catch { return null; }
}

/** Observe the current Host tree using the platform-native provider. */
function observeCurrentProcessTreeRss(): { totalRssMiB: number; descendantRssMiB: number } | null {
  if (process.platform !== 'win32') return observeProcessTreeRss()
  try {
    // The provider is optional at this frontend's published version: older DSH
    // runtimes have no native RSS export and safely report the observation absent.
    const observeWindowsProcessTreeRss = (subprocessLocal as unknown as {
      observeWindowsProcessTreeRss?: () => { totalRssBytes: number; descendantRssBytes: number } | undefined
    }).observeWindowsProcessTreeRss
    const observed = observeWindowsProcessTreeRss?.()
    if (observed === undefined) return null
    return {
      totalRssMiB: Math.ceil(observed.totalRssBytes / MiB),
      descendantRssMiB: Math.ceil(observed.descendantRssBytes / MiB),
    }
  } catch {
    // Native access can be denied for protected processes; unknown is safer than an invented value.
    return null
  }
}

const MiB = 1024 * 1024;
const MAX_RUNTIME_COMPONENTS = 128;
const MAX_RUNTIME_ARTIFACTS_PER_COMPONENT = 4096;
const MAX_RUNTIME_PATCHES = 128;
const runtimeFileIdentitySchema = z.object({
  path: z.string().min(1).max(1024), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const runtimeInventorySchema = z.object({
  components: z.array(z.object({
    name: z.string().min(1).max(128), version: z.string().min(1).max(64),
    manifest: runtimeFileIdentitySchema,
    artifacts: z.array(runtimeFileIdentitySchema).max(MAX_RUNTIME_ARTIFACTS_PER_COMPONENT),
  }).strict()).min(1).max(MAX_RUNTIME_COMPONENTS),
  patches: z.array(runtimeFileIdentitySchema).max(MAX_RUNTIME_PATCHES),
}).passthrough();
const RuntimeRecord = z.object({
  schemaVersion: z.literal(1), status: z.literal('ready'), runId: z.string().min(1), hostPid: z.number().int().positive(),
  observedAtUnixMs: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), harnessRoot: z.string(),
  desktopVersion: z.string(), harnessVersion: z.string(), port: z.number().int().min(1).max(65535),
  disabledPlugins: z.array(z.string()),
  buildProvenance: z.object({ mode: z.enum(['release', 'development']), source: z.object({
    gitCommit: z.string(), gitTree: z.string(), dirty: z.boolean(), sourceSha256: z.string(),
  }), inventory: runtimeInventorySchema.optional() }).nullable(),
});

type RuntimeInventory = z.infer<typeof runtimeInventorySchema>;

type RuntimeObservation = {
  available: boolean; observedAt: string; reason: string | null;
  identity: null | {
    startedAtUnixMs: number; desktopVersion: string; harnessVersion: string;
    contentSha256: string; hostPid: number; port: number;
    source: null | { gitCommit: string; gitTree: string; dirty: boolean; sourceSha256: string; mode: string };
    disabledPlugins: string[];
    inventory: null | {
      components: Array<{ name: string; version: string; manifestSha256: string; artifactCount: number; artifactsSha256: string }>;
      patches: Array<{ name: string; sha256: string }>;
    };
  };
};

/** Project build inventory without disclosing source or installation paths. */
function projectRuntimeInventory(inventory: RuntimeInventory): NonNullable<RuntimeObservation['identity']>['inventory'] {
  const components = inventory.components.map(component => {
    const artifactHash = createHash('sha256');
    for (const artifact of [...component.artifacts].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
      artifactHash.update(JSON.stringify([artifact.path, artifact.bytes, artifact.sha256]));
      artifactHash.update('\n');
    }
    return {
      name: component.name,
      version: component.version,
      manifestSha256: component.manifest.sha256,
      artifactCount: component.artifacts.length,
      artifactsSha256: artifactHash.digest('hex'),
    };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
  const patches = inventory.patches.map(patch => {
    const name = patch.path.slice(patch.path.lastIndexOf('/') + 1);
    if (!/^[A-Za-z0-9@][A-Za-z0-9@._+-]{0,127}$/u.test(name)) throw new Error('Runtime patch identity is invalid');
    return { name, sha256: patch.sha256 };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { components, patches };
}

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
      contentSha256: value.contentSha256,
      hostPid: value.hostPid, port: value.port,
      source: source ? { gitCommit: source.gitCommit, gitTree: source.gitTree, dirty: source.dirty,
        sourceSha256: source.sourceSha256, mode: value.buildProvenance!.mode } : null,
      disabledPlugins: value.disabledPlugins,
      inventory: value.buildProvenance?.inventory === undefined ? null : projectRuntimeInventory(value.buildProvenance.inventory),
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
  const maxProcessTreeRssMiB = config.maxProcessTreeRssMiB ?? maxRssMiB;
  const maxConcurrentHeavyTools = config.maxConcurrentHeavyTools ?? 2;
  for (const [key, value] of Object.entries({ maxRssMiB, maxProcessTreeRssMiB, maxConcurrentHeavyTools })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Runtime ${key} must be a positive safe integer`);
  }
  const heavyToolPatterns = config.heavyToolPatterns ?? ['(^|_)(bash|pwsh|shell|subagent|teams?|workflow)(_|$)', '^csv_process$'];
  if (heavyToolPatterns.length === 0) throw new Error('Runtime heavyToolPatterns must not be empty');
  const patterns = heavyToolPatterns.map(pattern => new RegExp(pattern));
  return { maxRssMiB, maxProcessTreeRssMiB, maxConcurrentHeavyTools, matches: (name: string) => patterns.some(pattern => pattern.test(name)) };
}

/**
 * Register live facts as logged context and a read-only tool; reject excess heavy dispatch.
 * @param ctx - DSH prompt, tool registry and plugin lifetime.
 * @param config - RSS and concurrency budgets, configurable through the frontend Host row.
 * @param readProcessTreeRss - Process-tree reader, injectable for deterministic tests.
 */
export function applyRuntimeGovernance(ctx: Omit<Context, 'sessions'>, config: RuntimeGovernanceConfig = {}, readProcessTreeRss: () => { totalRssMiB: number; descendantRssMiB: number } | null = observeCurrentProcessTreeRss): void {
  const limits = resolveRuntimeBudgets(config);
  let activeHeavyTools = 0;
  const resources = () => {
    const hostRssMiB = Math.ceil(process.memoryUsage.rss() / MiB);
    const processTree = readProcessTreeRss();
    return { hostRssMiB, descendantRssMiB: processTree?.descendantRssMiB ?? null, processTreeRssMiB: processTree?.totalRssMiB ?? null,
      maxRssMiB: limits.maxRssMiB, maxProcessTreeRssMiB: limits.maxProcessTreeRssMiB, activeHeavyTools, maxConcurrentHeavyTools: limits.maxConcurrentHeavyTools };
  };
  const observe = () => ({ ...observeRuntime(process.env.CLAWMASTER_RUNTIME_STATE), resources: resources() });
  const overBudget = (): 'host' | 'process-tree' | null => {
    const current = resources();
    if (current.hostRssMiB >= limits.maxRssMiB) return 'host';
    if (current.processTreeRssMiB !== null && current.processTreeRssMiB >= limits.maxProcessTreeRssMiB) return 'process-tree';
    return null;
  };
  ctx.systemPrompt.context({
    name: 'clawmaster-current-runtime', order: 100,
    text: () => process.env.CLAWMASTER_RUNTIME_STATE ? [
      'Current ClawMaster runtime observation: ' + JSON.stringify(observe()),
      'Runtime versions, component digests, ports, PIDs, permissions and resource measurements are volatile. '
      + 'Treat remembered values as dated history. Use runtime_status and the owning live settings before reporting current facts. '
      + 'Record an as-of timestamp for historical observations; never present a runtime directory as a durable business workspace.',
    ].join('\n') : '',
  });
  ctx.tools.register(defineTool({
    name: 'runtime_status', description: 'Read current ClawMaster desktop identity, source provenance, bounded component and patch identities, and Host resource budgets with an observation timestamp. Filesystem paths, credentials and business data are omitted. Remembered runtime facts are historical; call this tool to verify current state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async () => JSON.stringify(observe()),
    presentCall: () => ({ card: 'generic', title: 'Runtime status', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
  }));
  ctx.tools.guard(exec => {
    if (!limits.matches(exec.name)) return;
    const exceeded = overBudget();
    if (exceeded === 'host') return `ClawMaster Host memory budget reached (${limits.maxRssMiB} MiB). No new heavy operation was started. Let active work finish and inspect runtime_status before retrying.`;
    if (exceeded === 'process-tree') return `ClawMaster Host process-tree memory budget reached (${limits.maxProcessTreeRssMiB} MiB). No new heavy operation was started. Let child work finish and inspect runtime_status before retrying.`;
  });
  ctx.on('tools/execute', async (exec, next) => {
    if (!limits.matches(exec.name)) return next();
    const exceeded = overBudget();
    if (exceeded === 'host') throw new Error(`ClawMaster Host memory budget reached (${limits.maxRssMiB} MiB). No new heavy operation was started.`);
    if (exceeded === 'process-tree') throw new Error(`ClawMaster Host process-tree memory budget reached (${limits.maxProcessTreeRssMiB} MiB). No new heavy operation was started.`);
    if (activeHeavyTools >= limits.maxConcurrentHeavyTools) {
      throw new Error(`ClawMaster heavy-operation concurrency budget reached (${limits.maxConcurrentHeavyTools}). Wait for active work to finish before retrying.`);
    }
    activeHeavyTools += 1;
    try { return await next(); }
    finally { activeHeavyTools -= 1; }
  });
}
