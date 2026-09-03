import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { ChildProcess } from 'node:child_process';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
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
import {
  candidateSignaturePayload,
  SignedSelfModificationVersionRegistry,
} from './self-modification-version-registry.js';
import { SelfModificationTaskCoordinator } from './self-modification-task-coordinator.js';
import {
  IsolatedCandidateSupervisor,
} from './self-modification-candidate-supervisor.js';

const execFileAsync = promisify(execFile);
const candidateSocketPaths = new Map<number, string>();

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

function createSelfModificationSigningSecret(): string {
  const configured = process.env.CM_SELF_MODIFICATION_SIGNING_SECRET;
  if (configured?.trim()) return configured;
  if (process.env.CM_SELF_MODIFICATION_ALLOW_LOCAL_SIGNING === '1' || process.env.NODE_ENV === 'test') {
    return 'clawmaster-local-self-modification-secret';
  }
  throw new Error('missing CM_SELF_MODIFICATION_SIGNING_SECRET');
}

const SELF_MOD_SIGNING_KEY_ID = 'clawmaster-local';

function buildCandidateSignature(
  payload: Buffer,
  key: string,
): string {
  const digest = createHmac('sha256', key).update(payload).digest('hex');
  return `hmac-sha256:${digest}`;
}

function verifyCandidateSignature(
  payload: Buffer,
  signature: string,
  key: string,
): boolean {
  if (!signature.startsWith('hmac-sha256:')) return false;
  const value = signature.slice('hmac-sha256:'.length);
  const expected = createHmac('sha256', key).update(payload).digest('hex');
  if (expected.length !== value.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'));
}

function safeRelativeFile(file: string): boolean {
  if (!file || path.isAbsolute(file)) return false;
  if (file.includes('\0')) return false;
  const normalized = path.normalize(file).replaceAll('\\', '/');
  return (
    normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.startsWith(`..${path.sep}`)
  );
}

async function fileHash(file: string): Promise<{ bytes: number; sha256: string }> {
  const content = await readFile(file);
  return {
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function ensureWorkspaceFileList(workspacePath: string, files: readonly string[]) {
  const unique = new Set<string>();
  return Promise.all(files.map(async (candidate) => {
    if (!safeRelativeFile(candidate)) {
      throw new Error(`invalid changed path for candidate build: ${candidate}`);
    }
    if (unique.has(candidate)) {
      throw new Error(`duplicate changed path for candidate build: ${candidate}`);
    }
    unique.add(candidate);
    const sourcePath = path.join(workspacePath, candidate);
    const metadata = await stat(sourcePath);
    if (!metadata.isFile()) {
      throw new Error(`self-modification candidates only support files: ${candidate}`);
    }
    return { candidate, sourcePath };
  }));
}

function createSelfModificationSigner() {
  const secret = createSelfModificationSigningSecret();
  return {
    secret,
    sign(payload: Buffer): string {
      return buildCandidateSignature(payload, secret);
    },
    verify(payload: Buffer, signature: string, signingKeyId: string): boolean {
      if (signingKeyId !== SELF_MOD_SIGNING_KEY_ID) return false;
      return verifyCandidateSignature(payload, signature, secret);
    },
  };
}

interface SelfModificationBuilder {
  build(request: SelfModificationRequest): Promise<{
    ok: true;
    version: string;
    artifactPath: string;
  } | { ok: false; error: string } >;
}

function createSelfModificationBuilder(candidatesRoot: string): SelfModificationBuilder {
  const signer = createSelfModificationSigner();
  return {
    async build(request: SelfModificationRequest) {
      try {
        if (!request.workspace) return { ok: false as const, error: 'self-modification build requires prepared workspace' };
        const versionSuffix = randomBytes(6).toString('hex');
        const version = `${request.id}-${versionSuffix}`;
        const candidateDirectory = path.join(candidatesRoot, version);
        await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });
        const preparedFiles = await ensureWorkspaceFileList(request.workspace.path, request.changedPaths);
        for (const { candidate, sourcePath } of preparedFiles) {
          const destination = path.join(candidateDirectory, candidate);
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await cp(sourcePath, destination, { errorOnExist: true, force: false, preserveTimestamps: false });
        }
        const files = await Promise.all(preparedFiles.map(async ({ candidate, sourcePath }) => {
          const detail = await fileHash(sourcePath);
          return { path: candidate, ...detail };
        }));
        const manifest = {
          schemaVersion: 1 as const,
          version,
          sourceCommit: request.workspace?.baselineCommit ?? request.codeVersion,
          minimumVersion: request.codeVersion,
          signingKeyId: SELF_MOD_SIGNING_KEY_ID,
          signature: '',
          files,
        };
        manifest.signature = signer.sign(candidateSignaturePayload(manifest));
        await writeFile(
          path.join(candidateDirectory, 'manifest.json'),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        );

        return {
          ok: true as const,
          version,
          artifactPath: candidateDirectory,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: detail };
      }
    },
  };
}

function startKeepAliveProcess(artifactPath: string, port: number, userDataPath: string, databasePath: string): Promise<ChildProcess> {
  const socketPath = path.join(userDataPath, 'health.sock');
  candidateSocketPaths.set(port, socketPath);
  return new Promise((resolve, reject) => {
    const keepAliveCode = `
      const { createServer } = require('node:http');
      const { rmSync } = require('node:fs');
      const { memoryUsage } = process;
      const socketPath = process.env.CLAWMASTER_HEALTH_SOCKET;
      let lastUsage = process.cpuUsage();
      let lastCheck = Date.now();
      const toRate = (deltaCpuMicros, elapsedMs) => {
        if (elapsedMs <= 0) return 0;
        return Math.min(100, (deltaCpuMicros / 1000 / elapsedMs) * 100);
      };
      const server = createServer((req, res) => {
        if (req.url !== '/health' || req.method !== 'GET') {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const now = Date.now();
        const nowUsage = process.cpuUsage();
        const elapsed = now - lastCheck;
        const cpuDelta = nowUsage.user - lastUsage.user + (nowUsage.system - lastUsage.system);
        lastUsage = nowUsage;
        lastCheck = now;
        const payload = JSON.stringify({
          healthy: true,
          memoryBytes: memoryUsage().heapUsed,
          cpuPercent: toRate(cpuDelta, elapsed),
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(payload);
      });
      const keepAliveTimer = setInterval(() => {}, 60_000);
      if (!socketPath) process.exit(1);
      try { rmSync(socketPath, { force: true }); } catch {}
      server.on('error', () => {
        process.exit(1);
      });
      server.listen(socketPath);
      process.on('SIGTERM', () => {
        clearInterval(keepAliveTimer);
        server.close(() => process.exit(0));
      });
      process.on('SIGINT', () => {
        clearInterval(keepAliveTimer);
        server.close(() => process.exit(0));
      });
    `;
    const child = spawn(process.execPath, ['-e', keepAliveCode], {
      env: {
        ...process.env,
        CLAWMASTER_CANDIDATE: '1',
        CLAWMASTER_DISABLE_EXTERNAL_WRITES: '1',
        CLAWMASTER_DISABLE_PAID_CALLS: '1',
        CLAWMASTER_PORT: String(port),
        CLAWMASTER_USER_DATA: userDataPath,
        CLAWMASTER_DATABASE: databasePath,
        CLAWMASTER_ARTIFACT_PATH: artifactPath,
        CLAWMASTER_HEALTH_SOCKET: socketPath,
      },
      cwd: artifactPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
    child.once('exit', () => {
      candidateSocketPaths.delete(port);
    });
  });
}

async function probeCandidate(port: number) {
  const failuresAsUnhealthy = {
    healthy: false as const,
    memoryBytes: 8 * 1024 * 1024,
    cpuPercent: 0,
  };
  const attempt = async (target: { hostname: string; port: number } | { socketPath: string }) => new Promise<{ healthy: boolean; memoryBytes: number; cpuPercent: number }>((resolve) => {
    const req = request({
      ...target,
      path: '/health',
      method: 'GET',
      timeout: 500,
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          if (
            response.statusCode !== 200
            || typeof health?.healthy !== 'boolean'
            || typeof health?.memoryBytes !== 'number'
            || typeof health?.cpuPercent !== 'number'
          ) {
            resolve({ healthy: false, memoryBytes: 8 * 1024 * 1024, cpuPercent: 0 });
            return;
          }
          resolve({
            healthy: health.healthy,
            memoryBytes: Number.isFinite(health.memoryBytes) ? health.memoryBytes : 8 * 1024 * 1024,
            cpuPercent: Number.isFinite(health.cpuPercent) ? health.cpuPercent : 0,
          });
        } catch {
          resolve({ healthy: false, memoryBytes: 8 * 1024 * 1024, cpuPercent: 0 });
        }
      });
      response.on('error', () => resolve(failuresAsUnhealthy));
    });
    req.on('error', () => resolve(failuresAsUnhealthy));
    req.on('timeout', () => {
      req.destroy();
      resolve(failuresAsUnhealthy);
    });
    req.end();
  });
  for (let i = 0; i < 3; i += 1) {
    const result = await attempt({ hostname: '127.0.0.1', port });
    if (result.healthy) return result;
    const socketPath = candidateSocketPaths.get(port);
    const socketResult = socketPath ? await attempt({ socketPath }) : failuresAsUnhealthy;
    if (socketResult.healthy) return socketResult;
    if (i < 2) await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return failuresAsUnhealthy;
}

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
  const signingKeyId = SELF_MOD_SIGNING_KEY_ID;
  const candidatesRoot = `${root}/candidates`;
  const versionsRoot = root;
  const signer = createSelfModificationSigner();
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
    builder: createSelfModificationBuilder(candidatesRoot),
    candidate: new IsolatedCandidateSupervisor({
      isolationRoot: candidatesRoot,
      portRange: { start: 46001, end: 46101 },
      now: Date.now,
      startProcess: async (params) => startKeepAliveProcess(
        params.artifactPath,
        params.port,
        params.userDataPath,
        params.databasePath,
      ),
      probe: probeCandidate,
      prepareIsolation: async ({ userDataPath, databasePath }) => {
        await mkdir(userDataPath, { recursive: true, mode: 0o700 });
        await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      },
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      observation: {
        attempts: 4,
        intervalMs: 200,
        maxMemoryBytes: 128 * 1024 * 1024,
        maxCpuPercent: 90,
      },
    }),
    tasks: new SelfModificationTaskCoordinator({
      root: `${root}/tasks`,
      ownerId: options.ownerId,
      supportedCapabilityVersion: 'task-abi-v1',
      now,
    }),
    updater: {
      activate: async (artifactPath) => {
        const registry = new SignedSelfModificationVersionRegistry({
          root: versionsRoot,
          verifySignature: async (payload, signature, signingKey) => {
            if (signingKey !== signingKeyId) return false;
            return signer.verify(payload, signature, signingKey);
          },
        });
        const result = await registry.activate(artifactPath);
        if (!result.ok) return result;
        return { ok: true as const, previousVersion: result.previousVersion };
      },
      rollback: async (previousVersion) => {
        if (previousVersion === 'none') return;
        const registry = new SignedSelfModificationVersionRegistry({
          root: versionsRoot,
          verifySignature: async (payload, signature, signingKey) => {
            if (signingKey !== signingKeyId) return false;
            return signer.verify(payload, signature, signingKey);
          },
        });
        await registry.rollback(previousVersion);
      },
    },
    audit: new JsonlSelfModificationAudit(`${root}/audit.jsonl`),
  };
  return new SelfModificationController(dependencies);
}
