/** Shared authorization for HTTP, tool, scheduler and plugin business consumers. */
import type { ExecutionIdentity } from './governance-audit.ts';
import { LOCAL_HTTP_IDENTITY } from './governance-audit.ts';

export type GovernanceAction = 'records.read' | 'records.write' | 'backup.export' | 'backup.restore'
  | 'audit.read' | 'task.read' | 'task.write' | 'task.review' | 'attachments.read';
export type GovernanceRole = 'administrator' | 'executor' | 'approver' | 'auditor';

/** A principal is resolved from authenticated transport state, never caller JSON or a desktop token. */
export interface GovernancePrincipal {
  organizationId: string;
  memberId: string;
  actor: 'human' | 'agent';
  sessionId?: string;
  /** Delegation records are established by the authority when a child Session is created. */
  delegatorId?: string;
}

/** Current membership is read for every operation, including the commit after an approval wait. */
export interface GovernanceMembership {
  active: boolean;
  roles: readonly GovernanceRole[];
  policyVersion: number;
  /** An empty list grants no resources; '*' grants all resources in this organization. */
  resources: readonly string[];
}

/** A deployment supplies a trusted identity provider and binds DSH Sessions server-side. */
export interface GovernanceAuthority {
  http(request: Request): Promise<GovernancePrincipal | undefined>;
  agent(sessionId: string): Promise<GovernancePrincipal | undefined>;
  membership(organizationId: string, memberId: string): Promise<GovernanceMembership | undefined>;
  /** Consume an exact, single-use approval from a different authorized human. */
  consumeApproval(request: {
    organizationId: string; executorId: string; action: GovernanceAction; resource: string;
    commandId: string; generation: number; revision: number; commandDigest: string;
  }): Promise<{ id: string; approverId: string } | undefined>;
}

export type GovernanceConfiguration = { mode: 'local' } | {
  mode: 'enterprise'; organizationId: string; authority: GovernanceAuthority;
};

/** Permission errors reveal no records and never trigger a fallback to local access. */
export class GovernanceDenied extends Error {
  readonly code = 'permission_denied';
  readonly reasonCode: 'permission_denied' | 'approval_rejected' | 'approval_cancelled' | 'approval_unavailable' | 'approval_missing' | 'approver_invalid';
  constructor(message = 'The authenticated caller cannot perform this operation.', reasonCode: GovernanceDenied['reasonCode'] = 'permission_denied') {
    super(message);
    this.reasonCode = reasonCode;
  }
}

const roleActions: Record<GovernanceRole, readonly GovernanceAction[]> = {
  administrator: ['records.read', 'records.write', 'backup.export', 'backup.restore', 'audit.read', 'task.read', 'task.write', 'task.review', 'attachments.read'],
  executor: ['records.read', 'records.write', 'task.read', 'task.write', 'attachments.read'],
  approver: ['records.read', 'task.read', 'task.review', 'attachments.read'],
  auditor: ['records.read', 'backup.export', 'audit.read', 'task.read', 'attachments.read'],
};

/** An operation retains its authenticated principal, while grants are re-read before every use. */
export interface GovernanceCaller {
  identity: ExecutionIdentity;
  check(action: GovernanceAction, resource?: string): Promise<ExecutionIdentity>;
  checkOwner(owner: { kind: 'local'; label: string } | { kind: 'member'; id: string }): Promise<void>;
  approve(action: GovernanceAction, resource: string, commandId: string, generation: number, revision: number, commandDigest: string): Promise<ExecutionIdentity>;
}

/** The durable store records metadata without receiving command bodies or exception messages. */
interface GovernanceOutcomeStore {
  recordOutcome(identity: ExecutionIdentity, operation: string, outcome: 'denied' | 'cancelled' | 'failed', commandId: string | undefined, reasonCode: string): void;
}

/**
 * Audit unsuccessful work only after the carrier has resolved a trusted caller.
 * @param caller Authenticated caller whose current policy facts accompany the record.
 * @param store Responsibility history owner.
 * @param operation Fixed operation name, never request prose.
 * @param commandId Validated command identifier, when available.
 * @param action Work without its own unsuccessful-outcome recorder.
 * @param signal Cancellation source whose exact reason distinguishes cancellation from failure.
 * @returns The action result; errors propagate after the metadata record commits.
 */
export async function auditGovernanceOutcome<T>(caller: GovernanceCaller, store: GovernanceOutcomeStore, operation: string,
  commandId: string | undefined, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try { return await action(); }
  catch (error) {
    const denied = error instanceof Error && 'code' in error && error.code === 'permission_denied';
    const aborted = signal?.aborted && error === signal.reason;
    const reason = error instanceof GovernanceDenied ? error.reasonCode : aborted ? 'operation_cancelled' : denied ? 'permission_denied' : 'operation_failed';
    const outcome = aborted || reason === 'approval_cancelled' ? 'cancelled' : reason === 'approval_unavailable' || !denied ? 'failed' : 'denied';
    store.recordOutcome(caller.identity, operation, outcome, commandId, reason);
    throw error;
  }
}

/** Local and enterprise callers share admission points without sharing identity semantics. */
export class GovernanceAccess {
  readonly mode: GovernanceConfiguration['mode'];
  private readonly config: GovernanceConfiguration;
  constructor(config: GovernanceConfiguration = { mode: 'local' }) {
    this.config = config;
    this.mode = config.mode;
    if (config.mode === 'enterprise' && (!config.organizationId || !config.authority
      || !['http', 'agent', 'membership', 'consumeApproval'].every(key => typeof config.authority[key as keyof GovernanceAuthority] === 'function'))) {
      throw new Error('Enterprise governance requires an organization and a trusted identity authority.');
    }
  }

  /** Resolve HTTP identity through the configured authority after the DSH carrier authenticates. */
  async http(request: Request): Promise<GovernanceCaller> {
    if (this.config.mode === 'local') return this.local(LOCAL_HTTP_IDENTITY);
    return this.enterprise(await this.config.authority.http(request), 'http');
  }

  /** Resolve the agent's initiating member; model arguments cannot select another identity. */
  async agent(sessionId: string | undefined, callId?: string): Promise<GovernanceCaller> {
    if (!sessionId) throw new GovernanceDenied('Business tools require an owning agent Session.');
    if (this.config.mode === 'local') return this.local({ ...LOCAL_HTTP_IDENTITY,
      actor: { kind: 'agent', id: sessionId }, source: 'tool', sessionId, ...(callId ? { callId } : {}) });
    const principal = await this.config.authority.agent(sessionId);
    if (principal?.actor !== 'agent' || principal.sessionId !== sessionId) throw new GovernanceDenied('The Session has no authenticated enterprise owner.');
    return this.enterprise(principal, 'tool', callId);
  }

  private local(identity: ExecutionIdentity): GovernanceCaller {
    return { identity, check: async action => {
      if (action === 'task.review' && identity.actor.kind !== 'local-human') throw new GovernanceDenied('Only a human can accept a task.');
      return identity;
    }, checkOwner: async owner => {
      if (owner.kind !== 'local') throw new GovernanceDenied('Local mode has no authenticated organization members.');
    }, approve: async () => { throw new GovernanceDenied('Local approvals are provided by the DSH one-shot approval service.'); } };
  }

  private enterprise(principal: GovernancePrincipal | undefined, source: 'http' | 'tool', callId?: string): GovernanceCaller {
    const config = this.config;
    if (config.mode !== 'enterprise' || !principal || principal.organizationId !== config.organizationId) throw new GovernanceDenied();
    const identity: ExecutionIdentity = {
      actor: { kind: principal.actor === 'human' ? 'member' : 'agent', id: principal.actor === 'human' ? principal.memberId : principal.sessionId! },
      principalId: principal.memberId, organizationId: config.organizationId, source, policyVersion: 0,
      ...(principal.sessionId ? { sessionId: principal.sessionId } : {}), ...(callId ? { callId } : {}),
    };
    const check = async (action: GovernanceAction, resource = '*'): Promise<ExecutionIdentity> => {
      const memberships = await Promise.all([principal.memberId, ...(principal.delegatorId ? [principal.delegatorId] : [])]
        .map(member => config.authority.membership(config.organizationId, member)));
      identity.policyVersion = Math.max(0, ...memberships.map(member => member?.policyVersion ?? 0));
      if (memberships.some(member => !member?.active || !member.roles.some(role => roleActions[role].includes(action))
        || (!member.resources.includes('*') && !member.resources.includes(resource)))
        || (action === 'task.review' && principal.actor !== 'human')) throw new GovernanceDenied();
      return { ...identity };
    };
    return { identity, check, checkOwner: async owner => {
      if (owner.kind !== 'member' || !(await config.authority.membership(config.organizationId, owner.id))?.active) {
        throw new GovernanceDenied('The task owner must be an active member of this organization.');
      }
    }, approve: async (action, resource, commandId, generation, revision, commandDigest) => {
      await check(action, resource);
      const approval = await config.authority.consumeApproval({ organizationId: config.organizationId, executorId: principal.memberId,
        action, resource, commandId, generation, revision, commandDigest });
      if (!approval || approval.approverId === principal.memberId) throw new GovernanceDenied('A distinct authorized approver is required.', 'approval_missing');
      const approver = await config.authority.membership(config.organizationId, approval.approverId);
      if (!approver?.active || !approver.roles.includes('approver')
        || (!approver.resources.includes('*') && !approver.resources.includes(resource))) throw new GovernanceDenied('The approver no longer has permission.', 'approver_invalid');
      return { ...await check(action, resource), approval: { ...approval, generation, revision } };
    } };
  }
}
