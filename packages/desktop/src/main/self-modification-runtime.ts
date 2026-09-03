import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  SelfModificationController,
  type SelfModificationDependencies,
  type SelfModificationRequest,
} from './self-modification-controller.js';
import {
  CommandSelfModificationVerifier,
  FileSelfModificationRepository,
  GitSelfModificationWorkspaceManager,
  JsonlSelfModificationAudit,
  type VerificationGateRunner,
} from './self-modification-infrastructure.js';
import { SelfModificationTaskCoordinator } from './self-modification-task-coordinator.js';

const execFileAsync = promisify(execFile);

export interface SelfModificationRuntimeOptions {
  repositoryRoot: string;
  userDataRoot: string;
  productionRoot: string;
  ownerId: string;
  now?(): string;
  runCommand?(command: string, args: string[], cwd: string): Promise<string>;
}

const FOCUSED_SELF_MODIFICATION_TESTS = [
  'src/main/self-modification-controller.test.ts',
  'src/main/self-modification-infrastructure.test.ts',
  'src/main/self-modification-candidate-supervisor.test.ts',
  'src/main/self-modification-task-coordinator.test.ts',
  'src/main/self-modification-ipc.test.ts',
] as const;

async function defaultRunCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return `${result.stdout}${result.stderr}`.trim();
}

function createGateRunner(
  runCommand: SelfModificationRuntimeOptions['runCommand'],
): VerificationGateRunner {
  const run = runCommand ?? defaultRunCommand;
  return async (gate, workspacePath, request: SelfModificationRequest) => {
    const runInWorkspace = (command: string, args: string[]) => run(command, args, workspacePath);
    try {
      const detail = gate === 'doctor'
        ? await runInWorkspace('npm', ['run', 'doctor'])
        : gate === 'diff-check'
          ? await runInWorkspace('git', ['diff', '--check'])
          : gate === 'focused-tests'
            ? await runInWorkspace('npm', ['--workspace', 'packages/desktop', 'exec', 'vitest', 'run', ...FOCUSED_SELF_MODIFICATION_TESTS])
            : gate === 'typecheck'
              ? await runInWorkspace('npm', ['--workspace', 'packages/desktop', 'run', 'build:main', '--', '--noEmit'])
              : gate === 'lint'
                ? await runInWorkspace('npm', [
                  '--workspace',
                  'packages/desktop',
                  'exec',
                  'eslint',
                  ...request.changedPaths.filter((entry) => /\.(?:ts|tsx)$/u.test(entry)),
                ])
                : gate === 'build'
                  ? await runInWorkspace('npm', ['--workspace', 'packages/desktop', 'run', 'build:main'])
                  : await runInWorkspace('npm', ['run', 'code-map:check']);
      return { ok: true, detail };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, detail };
    }
  };
}

export function createSelfModificationRuntime(options: SelfModificationRuntimeOptions): SelfModificationController {
  const now = options.now ?? (() => new Date().toISOString());
  const root = `${options.userDataRoot}/self-modification`;
  const dependencies: SelfModificationDependencies = {
    productionRoot: options.productionRoot,
    now,
    createId: () => randomUUID(),
    repository: new FileSelfModificationRepository(`${root}/requests`),
    workspaces: new GitSelfModificationWorkspaceManager({
      repositoryRoot: options.repositoryRoot,
      workspaceRoot: `${root}/worktrees`,
      run: async (command, args) => (options.runCommand ?? defaultRunCommand)(command, args, options.repositoryRoot),
    }),
    verifier: new CommandSelfModificationVerifier(createGateRunner(options.runCommand)),
    builder: {
      build: async () => ({
        ok: false as const,
        error: 'self-modification artifact builder is not connected yet',
      }),
    },
    candidate: {
      start: async () => ({
        ok: false as const,
        error: 'self-modification candidate supervisor is not connected yet',
      }),
      observe: async () => ({ ok: false as const, error: 'self-modification candidate is not running' }),
      stop: async () => undefined,
    },
    tasks: new SelfModificationTaskCoordinator({
      root: `${root}/tasks`,
      ownerId: options.ownerId,
      supportedCapabilityVersion: 'task-abi-v1',
      now,
    }),
    updater: {
      activate: async () => ({
        ok: false as const,
        error: 'self-modification atomic updater is not connected yet',
        previousVersion: 'current',
        requiresRollback: false,
      }),
      rollback: async () => undefined,
    },
    audit: new JsonlSelfModificationAudit(`${root}/audit.jsonl`),
  };
  return new SelfModificationController(dependencies);
}
