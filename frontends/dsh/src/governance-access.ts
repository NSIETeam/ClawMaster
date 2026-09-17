/** Shared authorization for HTTP, tool, scheduler and plugin business consumers. */
import type { ExecutionIdentity } from './governance-audit.ts';
import { LOCAL_HTTP_IDENTITY } from './governance-audit.ts';
import { z } from 'zod';

export type GovernanceAction = 'records.read' | 'records.write' | 'backup.export' | 'backup.restore'
  | 'audit.read' | 'task.read' | 'task.write' | 'task.review' | 'attachments.read' | 'workspace.create';
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
  http(request: Request, signal?: AbortSignal): Promise<GovernancePrincipal | undefined>;
  agent(sessionId: string, signal?: AbortSignal): Promise<GovernancePrincipal | undefined>;
  membership(organizationId: string, memberId: string, signal?: AbortSignal): Promise<GovernanceMembership | undefined>;
  /** Consume an exact, single-use approval from a different authorized human. */
  consumeApproval(request: {
    organizationId: string; executorId: string; action: GovernanceAction; resource: string;
    commandId: string; generation: number; revision: number; commandDigest: string;
  }, signal?: AbortSignal): Promise<{ id: string; approverId: string } | undefined>;
}

const authorityIdentifier = z.string().min(1).max(128);
const authorityPrincipalSchema = z.object({
  organizationId: authorityIdentifier,
  memberId: authorityIdentifier,
  actor: z.enum(['human', 'agent']),
  sessionId: authorityIdentifier.optional(),
  delegatorId: authorityIdentifier.optional(),
}).superRefine((value, context) => {
  if (value.actor === 'agent' && value.sessionId === undefined) {
    context.addIssue({ code: 'custom', message: 'Agent identity is missing its Session binding.' });
  }
});
const authorityMembershipSchema = z.object({
  active: z.boolean(), roles: z.array(z.enum(['administrator', 'executor', 'approver', 'auditor'])),
  policyVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  resources: z.array(authorityIdentifier),
});
const authorityApprovalSchema = z.object({ id: authorityIdentifier, approverId: authorityIdentifier });

/**
 * Parse provider output at the identity boundary and hide provider details from callers.
 * @param schema Schema for one authority response.
 * @param value Provider output, including its optional undefined result.
 * @param label Response kind used only for a stable local diagnostic.
 * @returns The validated provider value, or undefined when the provider found no identity.
 * @throws Error when a provider returns a malformed response; consumers map this to unavailable.
 */
function authorityResult<T>(schema: z.ZodType<T>, value: unknown, label: string): T | undefined {
  if (value === undefined) return undefined;
  try { return schema.parse(value); }
  catch { throw new Error(`Governance authority returned an invalid ${label} response.`); }
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
  administrator: ['records.read', 'records.write', 'backup.export', 'backup.restore', 'audit.read', 'task.read', 'task.write', 'task.review', 'attachments.read', 'workspace.create'],
  executor: ['records.read', 'records.write', 'task.read', 'task.write', 'attachments.read', 'workspace.create'],
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

/** Cancellation fences each authority await; a late provider result cannot continue authorization. */
function waitForAuthority<T>(signal: AbortSignal | undefined, start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remove = () => signal?.removeEventListener('abort', abort);
    const abort = () => { remove(); reject(signal!.reason); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => { signal?.throwIfAborted(); return start(); }).then(value => {
      remove();
      if (signal?.aborted) reject(signal.reason); else resolve(value);
    }, error => { remove(); reject(error); });
  });
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

  /**
   * Refuse a deployment that connects consumers to another organization's durable data.
   * @param organizationId Binding read by the database owner, never request JSON.
   */
  assertOrganization(organizationId: string): void {
    const expected = this.config.mode === 'enterprise' ? this.config.organizationId : 'local';
    if (organizationId !== expected || (this.config.mode === 'enterprise' && expected === 'local')) {
      throw new Error('Invalid governance configuration: organization mismatch.');
    }
  }

  /** Resolve HTTP identity through the configured authority after the DSH carrier authenticates. */
  async http(request: Request, signal: AbortSignal = request.signal): Promise<GovernanceCaller> {
    signal.throwIfAborted();
    if (this.config.mode === 'local') return this.local(LOCAL_HTTP_IDENTITY, signal);
    const config = this.config;
    const principal = await waitForAuthority(signal, () => config.authority.http(request, signal));
    return this.enterprise(authorityResult(authorityPrincipalSchema, principal, 'HTTP identity'), 'http', undefined, signal);
  }

  /** Resolve the agent's initiating member; model arguments cannot select another identity. */
  async agent(sessionId: string | undefined, callId?: string, signal?: AbortSignal): Promise<GovernanceCaller> {
    signal?.throwIfAborted();
    if (!sessionId) throw new GovernanceDenied('Business tools require an owning agent Session.');
    if (this.config.mode === 'local') return this.local({ ...LOCAL_HTTP_IDENTITY,
      actor: { kind: 'agent', id: sessionId }, source: 'tool', sessionId, ...(callId ? { callId } : {}) }, signal);
    const config = this.config;
    const result = await waitForAuthority(signal, () => config.authority.agent(sessionId, signal));
    const principal = authorityResult(authorityPrincipalSchema, result, 'Session identity');
    if (principal?.actor !== 'agent' || principal.sessionId !== sessionId) throw new GovernanceDenied('The Session has no authenticated enterprise owner.');
    return this.enterprise(principal, 'tool', callId, signal);
  }

  private local(identity: ExecutionIdentity, signal?: AbortSignal): GovernanceCaller {
    return { identity, check: async action => {
      signal?.throwIfAborted();
      if (action === 'task.review' && identity.actor.kind !== 'local-human') throw new GovernanceDenied('Only a human can accept a task.');
      return identity;
    }, checkOwner: async owner => {
      signal?.throwIfAborted();
      if (owner.kind !== 'local') throw new GovernanceDenied('Local mode has no authenticated organization members.');
    }, approve: async () => { throw new GovernanceDenied('Local approvals are provided by the DSH one-shot approval service.'); } };
  }

  private enterprise(principal: GovernancePrincipal | undefined, source: 'http' | 'tool', callId?: string, signal?: AbortSignal): GovernanceCaller {
    const config = this.config;
    if (config.mode !== 'enterprise' || !principal || principal.organizationId !== config.organizationId) throw new GovernanceDenied();
    const identity: ExecutionIdentity = {
      actor: { kind: principal.actor === 'human' ? 'member' : 'agent', id: principal.actor === 'human' ? principal.memberId : principal.sessionId! },
      principalId: principal.memberId, organizationId: config.organizationId, source, policyVersion: 0,
      ...(principal.sessionId ? { sessionId: principal.sessionId } : {}), ...(callId ? { callId } : {}),
    };
    const check = async (action: GovernanceAction, resource = '*'): Promise<ExecutionIdentity> => {
      const memberships = await waitForAuthority(signal, () => Promise.all([principal.memberId, ...(principal.delegatorId ? [principal.delegatorId] : [])]
        .map(async member => authorityResult(authorityMembershipSchema,
          await config.authority.membership(config.organizationId, member, signal), 'membership'))));
      identity.policyVersion = Math.max(0, ...memberships.map(member => member?.policyVersion ?? 0));
      if (memberships.some(member => !member?.active || !member.roles.some(role => roleActions[role].includes(action))
        || (!member.resources.includes('*') && !member.resources.includes(resource)))
        || (action === 'task.review' && principal.actor !== 'human')) throw new GovernanceDenied();
      return { ...identity };
    };
    return { identity, check, checkOwner: async owner => {
      const membership = owner.kind === 'member'
        ? await waitForAuthority(signal, () => config.authority.membership(config.organizationId, owner.id, signal))
        : undefined;
      const checked = authorityResult(authorityMembershipSchema, membership, 'owner membership');
      if (owner.kind !== 'member' || !checked?.active) {
        throw new GovernanceDenied('The task owner must be an active member of this organization.');
      }
    }, approve: async (action, resource, commandId, generation, revision, commandDigest) => {
      await check(action, resource);
      const approvalResult = await waitForAuthority(signal, () => config.authority.consumeApproval({ organizationId: config.organizationId, executorId: principal.memberId,
        action, resource, commandId, generation, revision, commandDigest }, signal));
      const approval = authorityResult(authorityApprovalSchema, approvalResult, 'approval');
      if (!approval || approval.approverId === principal.memberId) throw new GovernanceDenied('A distinct authorized approver is required.', 'approval_missing');
      const approver = await waitForAuthority(signal, () => config.authority.membership(config.organizationId, approval.approverId, signal));
      const checkedApprover = authorityResult(authorityMembershipSchema, approver, 'approver membership');
      if (!checkedApprover?.active || !checkedApprover.roles.includes('approver')
        || (!checkedApprover.resources.includes('*') && !checkedApprover.resources.includes(resource))) throw new GovernanceDenied('The approver no longer has permission.', 'approver_invalid');
      return { ...await check(action, resource), approval: { kind: 'authority', ...approval, generation, revision } };
    } };
  }
}
