import type {
  ApprovalActor,
  SelfModificationController,
  SelfModificationRequest,
} from './self-modification-controller.js';

export const SELF_MODIFICATION_IPC = Object.freeze({
  list: 'clawmaster:self-modification-list',
  create: 'clawmaster:self-modification-create',
  prepare: 'clawmaster:self-modification-prepare',
  verify: 'clawmaster:self-modification-verify',
  approve: 'clawmaster:self-modification-approve',
  reject: 'clawmaster:self-modification-reject',
  cancel: 'clawmaster:self-modification-cancel',
  buildAndActivate: 'clawmaster:self-modification-build-activate',
} as const);

export interface IpcHandleRegistry {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void;
}

type CreateInput = Pick<SelfModificationRequest, 'goal' | 'tenantId' | 'actorId' | 'changedPaths'> &
  Partial<Pick<
    SelfModificationRequest,
    'origin' | 'inputVersion' | 'codeVersion' | 'capabilityVersion' | 'usage' | 'idempotencyKey'
  >>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('self-modification payload must be an object');
  return input as Record<string, unknown>;
}

function asSafeId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !SAFE_ID.test(input)) throw new Error(`${label} must be a safe identifier`);
  return input;
}

function asText(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 4_000) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return input.trim();
}

function asChangedPaths(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('changed paths must be an array');
  return input.map((entry) => {
    if (typeof entry !== 'string' || entry.startsWith('/') || entry.includes('..') || entry.length > 260) {
      throw new Error('changed paths must be relative repository paths');
    }
    return entry;
  });
}

function asUsage(input: unknown): SelfModificationRequest['usage'] | undefined {
  if (input === undefined) return undefined;
  const value = asRecord(input);
  const tokenCount = Number(value.tokenCount ?? 0);
  const retryCount = Number(value.retryCount ?? 0);
  const estimatedCostUsd = Number(value.estimatedCostUsd ?? 0);
  if (!Number.isFinite(tokenCount) || tokenCount < 0) throw new Error('token count must be a non-negative number');
  if (!Number.isFinite(retryCount) || retryCount < 0) throw new Error('retry count must be a non-negative number');
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('estimated cost must be a non-negative number');
  return {
    tokenCount,
    retryCount,
    estimatedCostUsd,
    ...(typeof value.provider === 'string' && value.provider.trim() ? { provider: value.provider.trim().slice(0, 120) } : {}),
  };
}

function parseCreate(input: unknown): CreateInput {
  const body = asRecord(input);
  return {
    goal: asText(body.goal, 'goal'),
    tenantId: asSafeId(body.tenantId, 'tenant id'),
    actorId: asSafeId(body.actorId, 'actor id'),
    changedPaths: asChangedPaths(body.changedPaths),
    ...(typeof body.origin === 'string' ? { origin: asText(body.origin, 'origin') } : {}),
    ...(typeof body.inputVersion === 'string' ? { inputVersion: asText(body.inputVersion, 'input version') } : {}),
    ...(typeof body.codeVersion === 'string' ? { codeVersion: asText(body.codeVersion, 'code version') } : {}),
    ...(typeof body.capabilityVersion === 'string' ? { capabilityVersion: asText(body.capabilityVersion, 'capability version') } : {}),
    ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: asSafeId(body.idempotencyKey, 'idempotency key') } : {}),
    usage: asUsage(body.usage),
  };
}

function parseReview(input: unknown): { id: string; actor: ApprovalActor } {
  const body = asRecord(input);
  const kind = body.kind;
  if (kind !== 'policy' && kind !== 'human' && kind !== 'security-reviewer') {
    throw new Error('review actor kind is invalid');
  }
  return {
    id: asSafeId(body.id, 'request id'),
    actor: { actorId: asSafeId(body.actorId, 'actor id'), kind },
  };
}

export function registerSelfModificationIpc(
  ipcMain: IpcHandleRegistry,
  controller: Pick<SelfModificationController, 'list' | 'create' | 'prepare' | 'verify' | 'approve' | 'reject' | 'cancel' | 'buildAndActivate'>,
): void {
  ipcMain.handle(SELF_MODIFICATION_IPC.list, () => controller.list());
  ipcMain.handle(SELF_MODIFICATION_IPC.create, async (_event, input) => controller.create(parseCreate(input)));
  ipcMain.handle(SELF_MODIFICATION_IPC.prepare, async (_event, id) => controller.prepare(asSafeId(id, 'request id')));
  ipcMain.handle(SELF_MODIFICATION_IPC.verify, async (_event, id) => controller.verify(asSafeId(id, 'request id')));
  ipcMain.handle(SELF_MODIFICATION_IPC.approve, async (_event, input) => {
    const { id, actor } = parseReview(input);
    return controller.approve(id, actor);
  });
  ipcMain.handle(SELF_MODIFICATION_IPC.reject, async (_event, input) => {
    const { id, actor } = parseReview(input);
    return controller.reject(id, actor);
  });
  ipcMain.handle(SELF_MODIFICATION_IPC.cancel, async (_event, id) => controller.cancel(asSafeId(id, 'request id')));
  ipcMain.handle(SELF_MODIFICATION_IPC.buildAndActivate, async (_event, id) =>
    controller.buildAndActivate(asSafeId(id, 'request id')));
}
