/**
 * Risk classification for a shell command line.
 *
 * The rule set is the harness's own reading of the taxonomy Codex ships in its auto-review
 * ("Guardian") policy, narrowed to what can be decided deterministically: identifying destructive
 * commands, resolving the target and scope the command actually names, and refusing to guess when
 * the target cannot be resolved. The reviewer's judgement calls — whether the *user* authorized
 * this exact target — are not modelled here; anything destructive is raised for approval instead,
 * which is the conservative side of that line.
 *
 * Rules, in the order they matter:
 *
 * - **critical** — irreversible damage with no plausible authorization: a root, home or
 *   shallow-glob deletion, a filesystem/partition writer, a fork bomb, deleting version history,
 *   or a command that shadows `HOME` before deleting through it.
 * - **high** — destructive but bounded once the target is read: deleting named paths, rewriting
 *   git history or discarding work, publishing/deploying, pruning containers or volumes, dropping
 *   database contents, killing processes, recursive permission changes, truncating a file.
 * - **medium** — a write that overwrites something which may already exist.
 * - **low** — everything else: reads, builds, tests, and writes that create rather than destroy.
 * @module @clawmaster/dsh-guard/classify
 */

import { expandWord, hasPattern, splitSegments, type ShellSegment } from './shell.ts';
import { posix, win32 } from 'node:path';
import { isWindowsPath, normalizePath as normalize, samePath, pathUnder } from './paths.ts';

/** Ordered risk levels; `critical` is the most severe. */
export type Risk = 'low' | 'medium' | 'high' | 'critical';

/** Severity order used to pick the worst finding in one command line. */
const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** What one reviewed action would touch, and why it matters. */
export interface Finding {
  /** Worst risk level across the command line. */
  risk: Risk;
  /** Stable code of the rule that fired (`delete.broad`, `git.reset-hard`, …). */
  code: string;
  /** One sentence a reader (model or user) can act on. */
  reason: string;
  /** Paths the action would act on, already expanded; `-` when the command names none. */
  targets: string[];
}

/** What the classifier needs to resolve a command line. */
export interface InspectContext {
  /** The user's home directory, for `~` and `$HOME`. */
  home: string;
  /** The directory the command runs in, for relative targets. */
  cwd: string;
}

/** Programs that delete files. */
const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put']);

/** Programs that write to a device or a filesystem. */
const DISK_PROGRAMS = new Set(['mkfs', 'newfs', 'wipefs', 'diskutil', 'fdisk', 'parted']);

/** Database clients: statement rules apply to what these programs are handed, not to prose. */
const DATABASE_PROGRAMS = new Set(['psql', 'sqlite3', 'mysql', 'mariadb', 'mongosh', 'mongo', 'redis-cli', 'clickhouse-client', 'duckdb', 'sqlcmd', 'trino']);

/** Wrappers that run the command after them: `sudo rm -rf /` is an `rm`, and reviewed as one. */
const PREFIX_PROGRAMS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'nohup', 'nice', 'time', 'exec', 'stdbuf', 'xargs']);

/** Home-level files and directories where an accidental redirect costs something personal. */
const HOME_SENSITIVE = ['.ssh', '.config', '.gnupg', '.claude', '.codex', '.dsh', '.zshrc', '.zprofile', '.bashrc', '.profile', '.gitconfig', 'Library'];

/** Paths whose deletion is never a bounded local edit. */
const SYSTEM_PATHS = new Set([
  '/', '/Users', '/home', '/var', '/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/Applications', '/opt', '/tmp', '/private',
]);

/** Risky git subcommands and the flags that make them destructive. */
const GIT_RULES: readonly { readonly test: RegExp; readonly code: string; readonly reason: string }[] = [
  { test: /^reset\b.*--hard\b/, code: 'git.reset-hard', reason: 'git reset --hard discards every uncommitted change in the working tree.' },
  { test: /^clean\b.*-[a-z]*[fdx]/, code: 'git.clean', reason: 'git clean deletes untracked (and with -x, ignored) files that version control cannot restore.' },
  { test: /^checkout\b.*(--\s+)?\.\s*$/, code: 'git.checkout-broad', reason: 'git checkout over the whole tree discards local edits in every file it touches.' },
  { test: /^restore\b.*\s\.\s*$/, code: 'git.restore-broad', reason: 'git restore over the whole tree discards local edits in every file it touches.' },
  { test: /^stash\b.*\b(drop|clear)\b/, code: 'git.stash-drop', reason: 'Dropping or clearing the stash deletes saved work that has no other copy.' },
  { test: /^branch\b.*\s-[dD]\b/, code: 'git.branch-delete', reason: 'git branch -D deletes a branch ref, which can orphan commits that exist nowhere else.' },
  { test: /^push\b.*(\s-f\b|\s--force\b|\s--force-with-lease\b|\s\+[A-Za-z0-9_./-]+)/, code: 'git.force-push', reason: 'A force push rewrites the remote branch and can destroy work other clones still hold.' },
  { test: /^worktree\b.*\bremove\b/, code: 'git.worktree-remove', reason: 'Removing a worktree deletes that checkout, including any uncommitted files in it.' },
  { test: /^(filter-branch|filter-repo)\b/, code: 'git.history-rewrite', reason: 'Rewriting history replaces every commit id and detaches existing clones.' },
  { test: /^reflog\b.*\bexpire\b/, code: 'git.reflog-expire', reason: 'Expiring the reflog removes the recovery path for commits that are no longer referenced.' },
  { test: /^gc\b.*--prune\b/, code: 'git.gc-prune', reason: 'Pruning unreachable objects deletes commits and blobs that were still recoverable.' },
];

/** Database statements that delete more than a bounded row set. */
const DATABASE_RULES: readonly { readonly test: RegExp; readonly code: string; readonly reason: string }[] = [
  { test: /\bdrop\s+(table|database|schema)\b/i, code: 'db.drop', reason: 'A DROP statement removes a table, schema or database outright.' },
  { test: /\btruncate\s+table\b/i, code: 'db.truncate', reason: 'TRUNCATE empties a table without a row-level way back.' },
  { test: /\bdelete\s+from\s+(?![^;]*\bwhere\b)[^;]*?(;|$)/i, code: 'db.delete-all', reason: 'A DELETE without a WHERE clause empties the table.' },
];

/** Programs whose presence alone means the call leaves the local read/write world. */
const RELEASE_PATTERNS: readonly { readonly test: RegExp; readonly code: string; readonly reason: string }[] = [
  { test: /^(npm|pnpm|yarn|bun)\s+(publish|unpublish)\b/, code: 'release.publish', reason: 'Publishing a package is durable, externally visible and hard to retract.' },
  { test: /^cargo\s+publish\b/, code: 'release.publish', reason: 'Publishing a crate is durable and externally visible.' },
  { test: /^twine\s+upload\b/, code: 'release.publish', reason: 'Uploading a distribution publishes it.' },
  { test: /^gh\s+(release\s+delete|repo\s+delete|api\b.*-X\s*DELETE)/, code: 'release.delete', reason: 'This deletes durable state on a remote host.' },
  { test: /^docker\s+(system\s+prune|volume\s+rm|rm\s+-f)/, code: 'docker.destroy', reason: 'Pruning or removing containers and volumes deletes stored data outside the working tree.' },
  { test: /^kubectl\s+delete\b/, code: 'cluster.delete', reason: 'Deleting cluster objects removes running or stored state.' },
  { test: /^terraform\s+(destroy|apply\s+-destroy)\b/, code: 'infra.destroy', reason: 'terraform destroy tears down provisioned infrastructure.' },
  { test: /^rsync\b.*--delete\b/, code: 'sync.delete', reason: 'rsync --delete removes destination files that are missing from the source.' },
  { test: /^rclone\s+(delete|purge)\b/, code: 'remote.delete', reason: 'This deletes objects on a remote store.' },
  { test: /^aws\s+s3\s+(rm|rb)\b.*--recursive\b/, code: 'remote.delete', reason: 'A recursive S3 removal deletes every object under the prefix.' },
  { test: /^(launchctl\s+(unload|bootout)|systemctl\s+(stop|disable))/i, code: 'service.stop', reason: 'Stopping or unloading a service interrupts a shared or user-visible capability.' },
];

/**
 * Classify one shell command line.
 * @param command - The raw command text.
 * @param context - Home and working directory used to expand targets.
 * @returns The worst finding for the line; a `low` finding with code `safe` when no rule fires.
 */
export function inspectShellCommand(command: string, context: InspectContext): Finding {
  const findings: Finding[] = [];
  for (const segment of splitSegments(command)) {
    const finding = inspectSegment(segment, context);
    if (finding !== undefined) findings.push(finding);
  }
  findings.push(...inspectRawText(command, context));
  return worst(findings) ?? { risk: 'low', code: 'safe', reason: 'No destructive pattern matched.', targets: ['-'] };
}

/** The highest-risk finding, or undefined when there are none. */
function worst(findings: readonly Finding[]): Finding | undefined {
  let best: Finding | undefined;
  for (const finding of findings) {
    if (best === undefined || RANK[finding.risk] > RANK[best.risk]) best = finding;
  }
  return best;
}

/** Positional arguments of a segment: flags removed, `--` honoured as the end of flags. */
function positional(segment: ShellSegment): string[] {
  const words = segment.argv.slice(1);
  const result: string[] = [];
  let literal = false;
  for (const word of words) {
    if (literal) { result.push(word); continue; }
    if (word === '--') { literal = true; continue; }
    if (word.startsWith('-') && word !== '-') continue;
    result.push(word);
  }
  return result;
}

/** True when the segment's command carries a recursive flag. */
function recursive(segment: ShellSegment): boolean {
  return segment.argv.slice(1).some(word => /^-[A-Za-z]*[rR]/.test(word) || word === '--recursive');
}

/** Resolve one word to an absolute path using the segment's own assignments, with `.`/`..` folded. */
function resolve(word: string, segment: ShellSegment, context: InspectContext): string {
  return normalize(expandWord(word, { home: context.home, cwd: context.cwd, assignments: segment.assignments }));
}

/** The parent of the working directory: deleting it removes the working tree and its siblings. */
function parentOf(cwd: string): string {
  return normalize(isWindowsPath(cwd) ? win32.dirname(cwd) : posix.dirname(cwd));
}

/** True when a path is a system, home or other tree root whose deletion is unbounded. */
function rootish(path: string, context: InspectContext): boolean {
  const trimmed = path.replace(/\/+$/, '') || '/';
  if (SYSTEM_PATHS.has(trimmed)) return true;
  if (samePath(path, context.home)) return true;
  if (isWindowsPath(path) && samePath(path, win32.parse(path).root)) return true;
  return false;
}

/**
 * Drop privilege and wrapper programs so the review sees the command that actually runs.
 * Flags and same-line assignments between the wrapper and the command are skipped too.
 * @param argv - One segment's argv.
 * @returns argv starting at the effective program.
 */
function stripPrefixes(argv: readonly string[]): string[] {
  let index = 0;
  while (index < argv.length) {
    const word = (argv[index] ?? '').split('/').pop() ?? '';
    if (!PREFIX_PROGRAMS.has(word)) break;
    index += 1;
    while (index < argv.length && ((argv[index] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? ''))) index += 1;
  }
  return argv.slice(index);
}

/** Classify one segment (one program invocation). */
function inspectSegment(segment: ShellSegment, context: InspectContext): Finding | undefined {
  const effective: ShellSegment = { ...segment, argv: stripPrefixes(segment.argv) };
  const program = (effective.argv[0] ?? '').split('/').pop() ?? '';
  if (program === '') return undefined;
  const name = program.toLowerCase();
  const words = positional(effective);
  const targets = words.map(word => resolve(word, effective, context));

  if (DELETE_PROGRAMS.has(name) || (name === 'gio' && effective.argv[1] === 'trash')) {
    return inspectDelete(effective, targets, context);
  }
  if (name === 'find') return inspectFind(effective, targets, context);
  if (DISK_PROGRAMS.has(name) || name.startsWith('mkfs') || name.startsWith('newfs')) {
    return { risk: 'critical', code: 'disk.destroy', reason: `${name} writes to a device or filesystem and can destroy every file on it, not just this project's.`, targets: targets.length > 0 ? targets : ['-'] };
  }
  if (name === 'dd' && effective.argv.some(word => /^of=\/dev\//.test(word))) {
    return { risk: 'critical', code: 'disk.destroy', reason: 'dd writing to a device node overwrites the raw device.', targets: ['-'] };
  }
  if (name === 'chmod' || name === 'chown') {
    if (recursive(segment) && targets.some(target => rootish(target, context))) {
      return { risk: 'critical', code: 'perm.recursive-root', reason: `A recursive ${name} over ${targets.join(', ')} can lock the account out of its own files.`, targets };
    }
    if (recursive(segment)) {
      return { risk: 'high', code: 'perm.recursive', reason: `A recursive ${name} changes every file below the target, including files this task never looked at.`, targets };
    }
    return undefined;
  }
  if (name === 'git') return inspectGit(segment);
  if (DATABASE_PROGRAMS.has(name)) return inspectDatabase(effective.argv.join(' '));
  if (name === 'truncate' && effective.argv.includes('-s')) {
    return { risk: 'high', code: 'file.truncate', reason: 'Truncating a file discards its previous contents in place, with no version-control safety net for untracked files.', targets };
  }
  if (name === 'kill' || name === 'pkill' || name === 'killall') {
    return { risk: 'high', code: 'process.kill', reason: 'Signalling processes can terminate work that is not this task\'s to stop, and `kill -9` leaves no chance to save state.', targets: targets.length > 0 ? targets : ['-'] };
  }
  for (const rule of RELEASE_PATTERNS) {
    if (rule.test.test(effective.raw)) return { risk: 'high', code: rule.code, reason: rule.reason, targets: targets.length > 0 ? targets : ['-'] };
  }
  if (effective.redirects.length > 0) {
    const redirects = effective.redirects.map(target => resolve(target, effective, context));
    if (redirects.some(target => homeSensitive(target, context))) {
      return { risk: 'high', code: 'write.home-redirect', reason: 'A redirect at the top of the home directory replaces a personal file — shell profile, SSH config, tool state — that is not part of this task.', targets: redirects };
    }
    return { risk: 'medium', code: 'write.redirect', reason: 'A redirect replaces the destination file\'s contents.', targets: redirects };
  }
  return undefined;
}

/**
 * True when a path is a home-level file or a home state directory rather than ordinary project
 * content — the difference between "the agent overwrote a build output" and "the agent overwrote
 * the user's shell profile".
 */
function homeSensitive(path: string, context: InspectContext): boolean {
  const home = normalize(context.home);
  if (samePath(path, home)) return true;
  if (!pathUnder(path, home)) return false;
  const rest = path.slice(home.length + 1);
  const first = rest.split('/')[0] ?? '';
  return !rest.includes('/') || HOME_SENSITIVE.includes(first);
}

/** Database statements: only what a database client is handed, never quoted prose in another command. */
function inspectDatabase(statement: string): Finding | undefined {
  for (const rule of DATABASE_RULES) {
    if (rule.test.test(statement)) return { risk: 'high', code: rule.code, reason: rule.reason, targets: ['-'] };
  }
  return undefined;
}

/** Deleting paths: critical when the target is a root or an unresolved blob, high when it is a named path. */
function inspectDelete(segment: ShellSegment, targets: readonly string[], context: InspectContext): Finding | undefined {
  if (segment.argv.some(word => word === '--no-preserve-root')) {
    return { risk: 'critical', code: 'delete.no-preserve-root', reason: 'Deleting with --no-preserve-root removes the filesystem guard that exists to prevent exactly this.', targets: targets.length > 0 ? [...targets] : ['-'] };
  }
  if (targets.length === 0) return undefined;
  const shadowsHome = 'HOME' in segment.assignments && segment.raw.includes('~');
  if (shadowsHome) {
    return { risk: 'critical', code: 'delete.shadowed-home', reason: 'This command reassigns HOME and then deletes through the reassigned path, so the real target cannot be read from the command alone.', targets: [...targets] };
  }
  const namesHistory = targets.some(target => /(^|\/)\.git(\/|$)/.test(target));
  if (namesHistory && recursive(segment)) {
    return { risk: 'critical', code: 'vcs.remove-history', reason: 'Deleting a .git directory removes the repository history that is the only copy of every commit here.', targets: [...targets] };
  }
  const parent = parentOf(context.cwd);
  const broad = targets.filter(target => rootish(target, context)
    || (recursive(segment) && (hasPattern(target) || samePath(target, context.cwd) || samePath(target, parent) || /\/\*$/.test(target))));
  if (broad.length > 0) {
    return { risk: 'critical', code: 'delete.broad', reason: `This deletes ${broad.join(', ')}, which is a root or an unresolved wildcard rather than a bounded set of files.`, targets: [...targets] };
  }
  return { risk: 'high', code: 'delete.path', reason: `This deletes ${targets.join(', ')}. Files outside version control have no way back.`, targets: [...targets] };
}

/** `find … -delete` / `-exec rm`: critical when rooted at a home or system tree. */
function inspectFind(segment: ShellSegment, targets: readonly string[], context: InspectContext): Finding | undefined {
  const raw = segment.raw;
  const deletes = raw.includes('-delete') || /-exec\s+(rm|unlink|shred)\b/.test(raw);
  if (!deletes) return undefined;
  const roots = targets.length > 0 ? targets : [context.cwd];
  if (roots.some(root => rootish(root, context))) {
    return { risk: 'critical', code: 'find.delete-broad', reason: `find with a delete action rooted at ${roots.join(', ')} can remove far more than this task's files.`, targets: [...roots] };
  }
  return { risk: 'high', code: 'find.delete', reason: 'find with a delete action removes every match, and the match set is only known after expansion.', targets: [...roots] };
}

/** Destructive git subcommands, matched on the subcommand text after `git`. */
function inspectGit(segment: ShellSegment): Finding | undefined {
  const rest = segment.argv.slice(1).join(' ').trim();
  if (rest === '') return undefined;
  for (const rule of GIT_RULES) {
    if (rule.test.test(rest)) return { risk: 'high', code: rule.code, reason: rule.reason, targets: ['-'] };
  }
  return undefined;
}

/**
 * Statement-level rules that hold regardless of which program runs them.
 * Only syntax lives here: content rules belong to the program that receives the content, so a
 * commit message quoting `DROP TABLE` is not mistaken for a database command.
 */
function inspectRawText(command: string, _context: InspectContext): Finding[] {
  if (command.includes(':(){') || /:\(\)\s*\{.*\};:/.test(command)) {
    return [{ risk: 'critical', code: 'resource.fork-bomb', reason: 'This is a fork bomb: it exhausts process slots and can hang the machine.', targets: ['-'] }];
  }
  return [];
}
