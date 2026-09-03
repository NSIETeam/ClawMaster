import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  SelfModificationDependencies,
  SelfModificationRequest,
} from './self-modification-controller.js';

type RequestRepository = SelfModificationDependencies['repository'];
type WorkspaceManager = SelfModificationDependencies['workspaces'];
type AuditSink = SelfModificationDependencies['audit'];
type ChangeVerifier = SelfModificationDependencies['verifier'];

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error('self-modification request id must be a safe identifier');
}

export class FileSelfModificationRepository implements RequestRepository {
  constructor(private readonly root: string) {}

  async save(request: SelfModificationRequest): Promise<void> {
    assertSafeId(request.id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, `${request.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async load(id: string): Promise<SelfModificationRequest | null> {
    assertSafeId(id);
    try {
      const parsed = JSON.parse(await readFile(path.join(this.root, `${id}.json`), 'utf8')) as SelfModificationRequest;
      if (parsed.id !== id) throw new Error('persisted self-modification request identity mismatch');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

async function defaultRunner(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

export class GitSelfModificationWorkspaceManager implements WorkspaceManager {
  private readonly run: CommandRunner;

  constructor(private readonly options: {
    repositoryRoot: string;
    workspaceRoot: string;
    run?: CommandRunner;
  }) {
    this.run = options.run ?? defaultRunner;
  }

  async create(id: string) {
    assertSafeId(id);
    const repositoryRoot = path.resolve(this.options.repositoryRoot);
    const workspaceRoot = path.resolve(this.options.workspaceRoot);
    const workspacePath = path.join(workspaceRoot, id);
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const baselineCommit = (await this.run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).trim();
    if (!/^[a-f0-9]{40}$/u.test(baselineCommit)) throw new Error('workspace baseline is not a full git commit');
    const branch = `self-change/${id}`;
    await this.run('git', ['-C', repositoryRoot, 'worktree', 'add', '-b', branch, workspacePath, baselineCommit]);
    return { path: workspacePath, branch, baselineCommit };
  }
}

function redact(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  if (/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]/iu.test(detail)) return '[REDACTED]';
  return detail.slice(0, 2_000);
}

export class JsonlSelfModificationAudit implements AuditSink {
  constructor(private readonly file: string) {}

  async emit(event: Parameters<SelfModificationDependencies['audit']['emit']>[0]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify({ ...event, detail: redact(event.detail) })}\n`, { mode: 0o600 });
  }
}

export const SELF_MODIFICATION_RELEASE_GATES = Object.freeze([
  'doctor', 'diff-check', 'focused-tests', 'typecheck', 'lint', 'build', 'code-map-check',
] as const);

export type VerificationGateRunner = (
  gate: typeof SELF_MODIFICATION_RELEASE_GATES[number],
  workspacePath: string,
  request: SelfModificationRequest,
) => Promise<{ ok: boolean; detail?: string }>;

export class CommandSelfModificationVerifier implements ChangeVerifier {
  constructor(private readonly run: VerificationGateRunner) {}

  async verify(request: SelfModificationRequest) {
    if (!request.workspace) throw new Error('self-modification verification requires an isolated workspace');
    const checks = [];
    for (const gate of SELF_MODIFICATION_RELEASE_GATES) {
      try {
        const result = await this.run(gate, request.workspace.path, request);
        checks.push({
          name: gate,
          status: result.ok ? 'passed' as const : 'failed' as const,
          detail: result.detail?.slice(0, 4_000),
        });
      } catch (error) {
        checks.push({
          name: gate,
          status: 'failed' as const,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
        });
      }
    }
    return { ok: checks.every((check) => check.status === 'passed'), checks };
  }
}
