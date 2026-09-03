import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SelfModificationDependencies } from './self-modification-controller.js';

type TaskAdapter = SelfModificationDependencies['tasks'];

export type ManagedSelfModificationTaskStatus =
  | 'active'
  | 'draining'
  | 'checkpointed'
  | 'resuming'
  | 'completed'
  | 'failed';

export type ExternalWriteCommitStatus = 'pending' | 'committed' | 'unknown' | 'failed';

export interface ExternalWriteOperation {
  idempotencyKey: string;
  origin: string;
  provider: string;
  fingerprint: string;
  status: ExternalWriteCommitStatus;
  retryCount: number;
  estimatedCostUsd?: number;
  tokenCount?: number;
  commitId?: string;
  response?: unknown;
  updatedAt: string;
}

export interface ManagedSelfModificationTask {
  id: string;
  requestId?: string;
  tenantId: string;
  ownerId: string;
  origin: string;
  inputVersion: string;
  codeVersion: string;
  capabilityVersion: string;
  status: ManagedSelfModificationTaskStatus;
  currentStage: string;
  checkpoint?: unknown;
  lastSuccessfulStage?: string;
  lease: { ownerId: string; expiresAt: string; heartbeatAt: string };
  externalWrites: ExternalWriteOperation[];
  tokenCount: number;
  provider?: string;
  estimatedCostUsd: number;
  retryCount: number;
  updatedAt: string;
}

export interface SelfModificationTaskSnapshot {
  id: string;
  requestId?: string;
  tenantId: string;
  origin: string;
  inputVersion: string;
  codeVersion: string;
  capabilityVersion: string;
  currentStage: string;
  tokenCount?: number;
  provider?: string;
  estimatedCostUsd?: number;
  retryCount?: number;
}

export interface SelfModificationCheckpointBundle {
  id: string;
  requestId: string;
  targetVersion?: string;
  createdAt: string;
  tasks: Array<{
    taskId: string;
    checkpoint: unknown;
    lastSuccessfulStage?: string;
    inputVersion: string;
    codeVersion: string;
    capabilityVersion: string;
    externalWrites: ExternalWriteOperation[];
  }>;
}

export interface SelfModificationTaskCoordinatorOptions {
  root: string;
  ownerId: string;
  supportedCapabilityVersion: string;
  now(): string;
  leaseDurationMs?: number;
  listActiveTasks?(requestId: string): Promise<SelfModificationTaskSnapshot[]>;
  pauseTask?(taskId: string): Promise<void>;
  captureCheckpoint?(taskId: string): Promise<unknown>;
  restoreTask?(input: {
    taskId: string;
    checkpoint: unknown;
    version: string;
    inputVersion: string;
    codeVersion: string;
    capabilityVersion: string;
  }): Promise<void>;
  reconcileExternalWrite?(operation: ExternalWriteOperation): Promise<ExternalWriteCommitStatus>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`${label} must be a safe identifier`);
}

function expiresAt(now: string, durationMs: number): string {
  return new Date(Date.parse(now) + durationMs).toISOString();
}

function isExpired(lease: ManagedSelfModificationTask['lease'], now: string): boolean {
  return Date.parse(lease.expiresAt) <= Date.parse(now);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

export class SelfModificationTaskCoordinator implements TaskAdapter {
  private readonly leaseDurationMs: number;

  constructor(private readonly options: SelfModificationTaskCoordinatorOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
  }

  async register(snapshot: SelfModificationTaskSnapshot): Promise<ManagedSelfModificationTask> {
    assertSafeId(snapshot.id, 'task id');
    const now = this.options.now();
    const task: ManagedSelfModificationTask = {
      ...snapshot,
      ownerId: this.options.ownerId,
      status: 'active',
      lease: { ownerId: this.options.ownerId, heartbeatAt: now, expiresAt: expiresAt(now, this.leaseDurationMs) },
      externalWrites: [],
      tokenCount: snapshot.tokenCount ?? 0,
      estimatedCostUsd: snapshot.estimatedCostUsd ?? 0,
      retryCount: snapshot.retryCount ?? 0,
      updatedAt: now,
    };
    await this.saveTask(task);
    return task;
  }

  async claimTask(taskId: string): Promise<ManagedSelfModificationTask> {
    const task = await this.requireTask(taskId);
    const now = this.options.now();
    if (task.status === 'draining' || task.status === 'checkpointed' || task.status === 'resuming') {
      throw new Error('task is fenced for self-modification activation');
    }
    if (task.lease.ownerId !== this.options.ownerId && !isExpired(task.lease, now)) {
      throw new Error('task lease is still owned by another runtime');
    }
    if (task.capabilityVersion !== this.options.supportedCapabilityVersion) {
      throw new Error('task capability version is not supported by this runtime');
    }
    task.ownerId = this.options.ownerId;
    task.lease = { ownerId: this.options.ownerId, heartbeatAt: now, expiresAt: expiresAt(now, this.leaseDurationMs) };
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  async heartbeat(taskId: string): Promise<ManagedSelfModificationTask> {
    const task = await this.requireTask(taskId);
    if (task.lease.ownerId !== this.options.ownerId) throw new Error('cannot heartbeat a task owned by another runtime');
    const now = this.options.now();
    task.lease.heartbeatAt = now;
    task.lease.expiresAt = expiresAt(now, this.leaseDurationMs);
    task.updatedAt = now;
    await this.saveTask(task);
    return task;
  }

  async recordExternalWrite(taskId: string, operation: Omit<ExternalWriteOperation, 'updatedAt'>): Promise<{
    status: ExternalWriteCommitStatus | 'recovered';
    shouldExecute: boolean;
  }> {
    assertSafeId(operation.idempotencyKey, 'idempotency key');
    const task = await this.requireTask(taskId);
    const existing = task.externalWrites.find((item) => item.idempotencyKey === operation.idempotencyKey);
    if (existing && existing.fingerprint !== operation.fingerprint) {
      throw new Error('idempotency key was already used for a different external write');
    }
    if (existing?.status === 'committed') return { status: 'recovered', shouldExecute: false };
    const now = this.options.now();
    const next = existing ?? { ...operation, updatedAt: now };
    next.status = operation.status;
    next.retryCount = operation.retryCount;
    next.commitId = operation.commitId;
    next.response = operation.response;
    next.updatedAt = now;
    if (!existing) task.externalWrites.push(next);
    task.retryCount += operation.retryCount;
    task.tokenCount += operation.tokenCount ?? 0;
    task.estimatedCostUsd += operation.estimatedCostUsd ?? 0;
    task.updatedAt = now;
    await this.saveTask(task);
    return { status: next.status, shouldExecute: next.status !== 'committed' };
  }

  async drainAndCheckpoint(requestId: string) {
    assertSafeId(requestId, 'request id');
    const snapshots = await this.options.listActiveTasks?.(requestId) ?? [];
    for (const snapshot of snapshots) {
      const existing = await this.loadTask(snapshot.id);
      if (!existing) await this.register({ ...snapshot, requestId });
    }
    const tasks = (await this.listTasks())
      .filter((task) => task.requestId === requestId && task.status === 'active');
    const checkpointId = `${requestId}-${Date.parse(this.options.now())}`;
    const bundle: SelfModificationCheckpointBundle = {
      id: checkpointId,
      requestId,
      createdAt: this.options.now(),
      tasks: [],
    };
    for (const task of tasks) {
      await this.claimTask(task.id);
      await this.options.pauseTask?.(task.id);
      const checkpoint = await this.options.captureCheckpoint?.(task.id) ?? task.checkpoint ?? null;
      const current = await this.requireTask(task.id);
      current.status = 'checkpointed';
      current.checkpoint = checkpoint;
      current.lastSuccessfulStage = current.currentStage;
      current.updatedAt = this.options.now();
      await this.saveTask(current);
      bundle.tasks.push({
        taskId: current.id,
        checkpoint,
        lastSuccessfulStage: current.lastSuccessfulStage,
        inputVersion: current.inputVersion,
        codeVersion: current.codeVersion,
        capabilityVersion: current.capabilityVersion,
        externalWrites: current.externalWrites,
      });
    }
    await this.saveCheckpoint(bundle);
    return { ok: true as const, checkpointId };
  }

  async resume(checkpointId: string, version: string): Promise<void> {
    const bundle = await this.requireCheckpoint(checkpointId);
    bundle.targetVersion = version;
    for (const entry of bundle.tasks) {
      if (entry.capabilityVersion !== this.options.supportedCapabilityVersion) {
        throw new Error(`checkpoint ${checkpointId} contains an incompatible task capability`);
      }
      const task = await this.requireTask(entry.taskId);
      task.status = 'resuming';
      task.updatedAt = this.options.now();
      await this.saveTask(task);
      await this.recoverExternalWrites(task);
      await this.options.restoreTask?.({
        taskId: entry.taskId,
        checkpoint: entry.checkpoint,
        version,
        inputVersion: entry.inputVersion,
        codeVersion: entry.codeVersion,
        capabilityVersion: entry.capabilityVersion,
      });
      task.status = 'active';
      task.codeVersion = version;
      task.lease = {
        ownerId: this.options.ownerId,
        heartbeatAt: this.options.now(),
        expiresAt: expiresAt(this.options.now(), this.leaseDurationMs),
      };
      task.updatedAt = this.options.now();
      await this.saveTask(task);
    }
    await this.saveCheckpoint(bundle);
  }

  private async recoverExternalWrites(task: ManagedSelfModificationTask): Promise<void> {
    for (const operation of task.externalWrites) {
      if (operation.status !== 'pending' && operation.status !== 'unknown') continue;
      if (!this.options.reconcileExternalWrite) {
        operation.status = 'unknown';
        operation.updatedAt = this.options.now();
        continue;
      }
      operation.status = await this.options.reconcileExternalWrite({ ...operation });
      operation.updatedAt = this.options.now();
    }
    await this.saveTask(task);
  }

  private taskPath(id: string): string {
    assertSafeId(id, 'task id');
    return path.join(this.options.root, 'tasks', `${id}.json`);
  }

  private checkpointPath(id: string): string {
    assertSafeId(id, 'checkpoint id');
    return path.join(this.options.root, 'checkpoints', `${id}.json`);
  }

  private async loadTask(id: string): Promise<ManagedSelfModificationTask | null> {
    return readJson<ManagedSelfModificationTask>(this.taskPath(id));
  }

  private async requireTask(id: string): Promise<ManagedSelfModificationTask> {
    const task = await this.loadTask(id);
    if (!task) throw new Error(`unknown managed task: ${id}`);
    return task;
  }

  private async saveTask(task: ManagedSelfModificationTask): Promise<void> {
    await writeJsonAtomic(this.taskPath(task.id), task);
  }

  private async listTasks(): Promise<ManagedSelfModificationTask[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.options.root, 'tasks'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const tasks = await Promise.all(
      names.filter((name) => name.endsWith('.json')).map((name) => this.loadTask(name.slice(0, -5))),
    );
    return tasks.filter((task): task is ManagedSelfModificationTask => task !== null);
  }

  private async saveCheckpoint(bundle: SelfModificationCheckpointBundle): Promise<void> {
    await writeJsonAtomic(this.checkpointPath(bundle.id), bundle);
  }

  private async requireCheckpoint(id: string): Promise<SelfModificationCheckpointBundle> {
    const checkpoint = await readJson<SelfModificationCheckpointBundle>(this.checkpointPath(id));
    if (!checkpoint) throw new Error(`unknown self-modification checkpoint: ${id}`);
    return checkpoint;
  }
}
