/**
 * Read-only target inspection, the guard's one look at the filesystem.
 *
 * Codex's auto-reviewer stats what a destructive command names before it judges it. The guard does
 * the same, for two reasons that do not require guessing:
 *
 * 1. **A symlink is a lie about its target.** `rm -rf ./link` reads as an ordinary path and can
 *    resolve into a protected directory, so the real path decides whether `denyPaths` applies.
 * 2. **A person deciding on an approval deserves the facts.** "Target: /x/y (directory, exists)"
 *    and "Target: /x/y (missing)" lead to different decisions, and the reason string is what both
 *    the user and the model see.
 *
 * The probe never changes a verdict in the *permissive* direction. It cannot: existence and size
 * are facts about the filesystem, not about what the command will do to it, and this file has no
 * business widening a blast radius on a heuristic. It only adds facts and can only deny.
 * @module @clawmaster/dsh-guard/probe
 */

import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { pathUnder } from './paths.ts';

/** Most targets one review probes, so a generated command cannot turn a review into a scan. */
export const MAX_PROBE_TARGETS = 8;

/** What one target turned out to be. */
export interface TargetProbe {
  /** The target as the command line named it. */
  target: string;
  /** Whether anything exists at the target. */
  exists: boolean;
  /** What exists there; `missing` covers every failure to read it, including permission denial. */
  kind: 'file' | 'directory' | 'other' | 'missing';
  /** The fully resolved path, when it could be resolved (a symlink resolves to what it points at). */
  realPath?: string;
  /** Whether the target itself is a link the command would follow. */
  symlink: boolean;
  /** Bytes for a file, so a reason can say how much would be lost. */
  size?: number;
}

/** Read-only inspection of the targets a command names. */
export type TargetProbeFn = (targets: readonly string[]) => TargetProbe[];

/** What the followed path is, in the vocabulary a reason can use. */
function kindOf(followed: Stats): TargetProbe['kind'] {
  if (followed.isDirectory()) return 'directory';
  if (followed.isFile()) return 'file';
  return 'other';
}

/**
 * Inspect targets without writing anything and without failing.
 * @param targets - Expanded targets from the classifier; `-` (none) is ignored.
 * @param limit - Most targets to inspect.
 * @returns One probe per real target, in the order given.
 */
export function probeTargets(targets: readonly string[], limit = MAX_PROBE_TARGETS): TargetProbe[] {
  const probes: TargetProbe[] = [];
  for (const target of targets) {
    if (target === '-' || probes.length >= limit) continue;
    const probe: TargetProbe = { target, exists: false, kind: 'missing', symlink: false };
    try {
      const link = lstatSync(target);
      probe.exists = true;
      probe.symlink = link.isSymbolicLink();
      try {
        const followed = statSync(target);
        probe.kind = kindOf(followed);
        if (followed.isFile()) probe.size = followed.size;
      } catch {
        // A link that points nowhere, or a path this process may not stat: the link itself is real.
        probe.kind = 'other';
      }
      try {
        const real = realpathSync(target);
        if (real !== target) probe.realPath = real;
      } catch {
        // Unresolvable is not a failure worth reporting; the literal target already stands.
      }
    } catch {
      // Missing, unreadable, or a permission boundary: all of them mean "nothing confirmed here".
      probe.exists = false;
      probe.kind = 'missing';
    }
    probes.push(probe);
  }
  return probes;
}

/** One human-readable clause describing a probe, or undefined when there is nothing to add. */
export function describeProbe(probe: TargetProbe): string | undefined {
  if (!probe.exists) return 'missing — nothing exists there to destroy';
  const size = probe.kind === 'file' && probe.size !== undefined ? `, ${probe.size} bytes` : '';
  // Only a link is worth flagging here; the decision layer reports any resolution that matters.
  const link = probe.symlink && probe.realPath !== undefined ? `, a link to ${probe.realPath}` : '';
  return `${probe.kind}${size}, exists${link}`;
}

/**
 * Whether a target resolves into a protected prefix. The literal target is checked by the caller
 * as well; this covers the case where a link's *contents* are protected while its path is not.
 * @param probe - One probe result.
 * @param prefixes - Protected path prefixes.
 * @returns The prefix that matched, or undefined.
 */
export function resolvedUnder(probe: TargetProbe, prefixes: readonly string[]): string | undefined {
  const candidates = [probe.target, ...probe.realPath === undefined ? [] : [probe.realPath]];
  for (const prefix of prefixes) {
    if (candidates.some(candidate => pathUnder(candidate, prefix))) return prefix;
  }
  return undefined;
}
