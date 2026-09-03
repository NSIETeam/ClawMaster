import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { SelfModificationDependencies, SelfModificationRequest } from './self-modification-controller.js';

type CandidateAdapter = SelfModificationDependencies['candidate'];

export interface CandidateProcessHandle {
  process: ChildProcess;
  port: number;
  userDataPath: string;
  databasePath: string;
}

export interface CandidateSupervisorOptions {
  isolationRoot: string;
  portRange: { start: number; end: number };
  startProcess(input: {
    artifactPath: string;
    port: number;
    userDataPath: string;
    databasePath: string;
    env: Record<string, string>;
  }): Promise<ChildProcess>;
  probe(port: number): Promise<{ healthy: boolean; memoryBytes: number; cpuPercent: number }>;
  prepareIsolation(input: { userDataPath: string; databasePath: string }): Promise<void>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  observation: { attempts: number; intervalMs: number; maxMemoryBytes: number; maxCpuPercent: number };
}

interface CandidateRecord extends CandidateProcessHandle {
  failures: number;
  stopped: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class IsolatedCandidateSupervisor implements CandidateAdapter {
  private readonly candidates = new Map<string, CandidateRecord>();
  private nextPort: number;

  constructor(private readonly options: CandidateSupervisorOptions) {
    this.nextPort = options.portRange.start;
  }

  async start(artifactPath: string, request: SelfModificationRequest) {
    if (!request.workspace || !SAFE_ID.test(request.id)) return { ok: false as const, error: 'candidate requires a safe isolated workspace' };
    if (!path.isAbsolute(artifactPath) || !path.isAbsolute(this.options.isolationRoot)) {
      return { ok: false as const, error: 'candidate paths must be absolute' };
    }
    if (this.nextPort > this.options.portRange.end) return { ok: false as const, error: 'candidate port range exhausted' };
    const candidateId = `${request.id}-${this.options.now()}`;
    const root = path.join(this.options.isolationRoot, candidateId);
    const userDataPath = path.join(root, 'user-data');
    const databasePath = path.join(root, 'database.sqlite');
    const port = this.nextPort++;
    try {
      await this.options.prepareIsolation({ userDataPath, databasePath });
      const process = await this.options.startProcess({
        artifactPath, port, userDataPath, databasePath,
        env: {
          CLAWMASTER_CANDIDATE: '1', CLAWMASTER_DISABLE_EXTERNAL_WRITES: '1',
          CLAWMASTER_DISABLE_PAID_CALLS: '1', CLAWMASTER_PORT: String(port),
          CLAWMASTER_USER_DATA: userDataPath, CLAWMASTER_DATABASE: databasePath,
        },
      });
      this.candidates.set(candidateId, { process, port, userDataPath, databasePath, failures: 0, stopped: false });
      return { ok: true as const, candidateId };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async observe(candidateId: string) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return { ok: false as const, error: 'unknown candidate process' };
    for (let attempt = 0; attempt < this.options.observation.attempts; attempt += 1) {
      if (candidate.process.exitCode !== null || candidate.process.killed) {
        return { ok: false as const, error: 'candidate exited during observation' };
      }
      const health = await this.options.probe(candidate.port);
      if (!health.healthy) candidate.failures += 1;
      else candidate.failures = 0;
      if (health.memoryBytes > this.options.observation.maxMemoryBytes) return { ok: false as const, error: 'candidate memory limit exceeded' };
      if (health.cpuPercent > this.options.observation.maxCpuPercent) return { ok: false as const, error: 'candidate CPU limit exceeded' };
      if (candidate.failures >= 2) return { ok: false as const, error: 'candidate health check failed repeatedly' };
      if (attempt + 1 < this.options.observation.attempts) await this.options.sleep(this.options.observation.intervalMs);
    }
    return { ok: true as const };
  }

  async stop(candidateId: string): Promise<void> {
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.stopped) return;
    candidate.stopped = true;
    candidate.process.kill('SIGTERM');
  }
}
