import path from 'node:path';

export type SelfModificationState =
  | 'draft' | 'editing' | 'verifying' | 'verification_failed' | 'review_required'
  | 'approved' | 'building' | 'build_failed' | 'candidate_running' | 'candidate_failed'
  | 'draining' | 'activating' | 'observing' | 'active' | 'activation_failed'
  | 'rolled_back' | 'rejected' | 'cancelled';

export type SelfModificationRisk = 'policy-auto' | 'human-confirmation' | 'security-review';

export interface VerificationCheck {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export interface SelfModificationRequest {
  id: string;
  goal: string;
  tenantId: string;
  actorId: string;
  changedPaths: string[];
  risk: SelfModificationRisk;
  state: SelfModificationState;
  createdAt: string;
  updatedAt: string;
  workspace?: { path: string; branch: string; baselineCommit: string };
  verification?: { ok: boolean; checks: VerificationCheck[] };
  approval?: { actorId: string; kind: ApprovalActor['kind']; at: string };
  candidate?: { id: string; version: string; artifactPath: string };
  checkpointId?: string;
  previousVersion?: string;
  failure?: string;
}

export interface ApprovalActor {
  actorId: string;
  kind: 'policy' | 'human' | 'security-reviewer';
}

export interface SelfModificationDependencies {
  productionRoot: string;
  now(): string;
  createId(): string;
  repository: {
    save(request: SelfModificationRequest): Promise<void>;
    load(id: string): Promise<SelfModificationRequest | null>;
    list(): Promise<SelfModificationRequest[]>;
  };
  workspaces: {
    create(id: string): Promise<{ path: string; branch: string; baselineCommit: string }>;
  };
  verifier: {
    verify(request: SelfModificationRequest): Promise<{ ok: boolean; checks: VerificationCheck[] }>;
  };
  builder: {
    build(request: SelfModificationRequest): Promise<
      | { ok: true; version: string; artifactPath: string }
      | { ok: false; error: string }
    >;
  };
  candidate: {
    start(artifactPath: string, request: SelfModificationRequest): Promise<
      | { ok: true; candidateId: string }
      | { ok: false; error: string }
    >;
    observe(candidateId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    stop(candidateId: string): Promise<void>;
  };
  tasks: {
    drainAndCheckpoint(requestId: string): Promise<
      | { ok: true; checkpointId: string }
      | { ok: false; error: string }
    >;
    resume(checkpointId: string, version: string): Promise<void>;
  };
  updater: {
    activate(artifactPath: string): Promise<
      | { ok: true; previousVersion: string }
      | { ok: false; error: string; previousVersion: string; requiresRollback: boolean }
    >;
    rollback(previousVersion: string): Promise<void>;
  };
  audit: { emit(event: { requestId: string; state: SelfModificationState; at: string; detail?: string }): Promise<void> };
}

const SECURITY_PATHS = [
  /(?:^|\/)self-modification-/u,
  /(?:^|\/)(?:update|incremental-update|incremental-signature|credential|audit|policy)/u,
  /(?:^|\/)src-tauri\//u,
  /(?:^|\/)migrations?\//u,
];

export function classifySelfModificationRisk(paths: readonly string[]): SelfModificationRisk {
  if (paths.some((entry) => SECURITY_PATHS.some((pattern) => pattern.test(entry)))) return 'security-review';
  if (paths.length > 0 && paths.every((entry) => /(?:^|\/)(?:skills|prompts|forms)\//u.test(entry))) {
    return 'policy-auto';
  }
  return 'human-confirmation';
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const ALLOWED_TRANSITIONS: Record<SelfModificationState, readonly SelfModificationState[]> = {
  draft: ['editing', 'cancelled'], editing: ['verifying', 'cancelled'],
  verifying: ['review_required', 'verification_failed', 'cancelled'], verification_failed: [],
  review_required: ['approved', 'rejected', 'cancelled'], approved: ['building', 'cancelled'],
  building: ['candidate_running', 'build_failed'], build_failed: [],
  candidate_running: ['draining', 'candidate_failed'], candidate_failed: [],
  draining: ['activating', 'activation_failed'], activating: ['observing', 'activation_failed'],
  observing: ['active', 'rolled_back'], active: [], activation_failed: ['rolled_back'],
  rolled_back: [], rejected: [], cancelled: [],
};

export class SelfModificationController {
  constructor(private readonly dependencies: SelfModificationDependencies) {}

  async create(input: Pick<SelfModificationRequest, 'goal' | 'tenantId' | 'actorId' | 'changedPaths'>) {
    const at = this.dependencies.now();
    const request: SelfModificationRequest = {
      ...input, changedPaths: [...input.changedPaths], id: this.dependencies.createId(),
      risk: classifySelfModificationRisk(input.changedPaths), state: 'draft', createdAt: at, updatedAt: at,
    };
    await this.persist(request);
    return request;
  }

  async prepare(id: string) {
    const request = await this.require(id);
    const workspace = await this.dependencies.workspaces.create(id);
    if (isInside(workspace.path, this.dependencies.productionRoot)) {
      throw new Error('self-modification workspace cannot be inside the production installation');
    }
    request.workspace = workspace;
    return this.transition(request, 'editing');
  }

  async verify(id: string) {
    let request = await this.transition(await this.require(id), 'verifying');
    const verification = await this.dependencies.verifier.verify(request);
    request.verification = verification;
    request = await this.transition(request, verification.ok ? 'review_required' : 'verification_failed');
    return request;
  }

  async approve(id: string, actor: ApprovalActor) {
    const request = await this.require(id);
    if (request.risk === 'security-review' && actor.kind !== 'security-reviewer') {
      throw new Error('protected code requires human security review');
    }
    if (request.risk === 'human-confirmation' && actor.kind === 'policy') {
      throw new Error('source changes require human confirmation');
    }
    request.approval = { ...actor, at: this.dependencies.now() };
    return this.transition(request, 'approved');
  }

  async reject(id: string, actor: ApprovalActor) {
    const request = await this.require(id);
    request.approval = { ...actor, at: this.dependencies.now() };
    return this.transition(request, 'rejected');
  }

  async cancel(id: string) {
    return this.transition(await this.require(id), 'cancelled');
  }

  async list() {
    return this.dependencies.repository.list();
  }

  async buildAndActivate(id: string) {
    let request = await this.transition(await this.require(id), 'building');
    const build = await this.dependencies.builder.build(request);
    if (!build.ok) return this.fail(request, 'build_failed', build.error);
    const started = await this.dependencies.candidate.start(build.artifactPath, request);
    if (!started.ok) return this.fail(request, 'candidate_failed', started.error);
    request.candidate = { id: started.candidateId, version: build.version, artifactPath: build.artifactPath };
    request = await this.transition(request, 'candidate_running');
    request = await this.transition(request, 'draining');
    const drained = await this.dependencies.tasks.drainAndCheckpoint(request.id);
    if (!drained.ok) return this.fail(request, 'activation_failed', drained.error);
    request.checkpointId = drained.checkpointId;
    request = await this.transition(request, 'activating');
    const activated = await this.dependencies.updater.activate(build.artifactPath);
    if (!activated.ok) {
      await this.dependencies.candidate.stop(started.candidateId);
      request = await this.fail(request, 'activation_failed', activated.error);
      if (activated.requiresRollback) await this.dependencies.updater.rollback(activated.previousVersion);
      await this.dependencies.tasks.resume(drained.checkpointId, activated.previousVersion);
      return this.transition(request, 'rolled_back');
    }
    request.previousVersion = activated.previousVersion;
    request = await this.transition(request, 'observing');
    const observed = await this.dependencies.candidate.observe(started.candidateId);
    if (observed.ok) {
      await this.dependencies.tasks.resume(drained.checkpointId, build.version);
      return this.transition(request, 'active');
    }
    await this.dependencies.updater.rollback(activated.previousVersion);
    await this.dependencies.tasks.resume(drained.checkpointId, activated.previousVersion);
    request.failure = observed.error;
    return this.transition(request, 'rolled_back');
  }

  private async require(id: string) {
    const request = await this.dependencies.repository.load(id);
    if (!request) throw new Error(`unknown self-modification request: ${id}`);
    return request;
  }

  private async fail(request: SelfModificationRequest, state: SelfModificationState, detail: string) {
    request.failure = detail;
    return this.transition(request, state);
  }

  private async transition(request: SelfModificationRequest, state: SelfModificationState) {
    if (!ALLOWED_TRANSITIONS[request.state].includes(state)) {
      throw new Error(`invalid self-modification transition: ${request.state} -> ${state}`);
    }
    request.state = state;
    request.updatedAt = this.dependencies.now();
    await this.persist(request, request.failure);
    return request;
  }

  private async persist(request: SelfModificationRequest, detail?: string) {
    await this.dependencies.repository.save(request);
    await this.dependencies.audit.emit({ requestId: request.id, state: request.state, at: request.updatedAt, detail });
  }
}
