/** Monotonic file permissions for ClawMaster's delegated DSH Sessions. */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';

type ActingAgent = NonNullable<ToolRunContext['agent']>;
const modes: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

/**
 * Intersect a delegated Session with its currently live ancestors; missing ancestry permits no file writes.
 * @param ctx - Existing DSH Agent registry, sandbox resolver and approval owner.
 * @param agent - Agent about to request a model step or execute a tool.
 */
export function constrainDelegatedPermissions(ctx: Context, agent: ActingAgent): void {
  if (agent.session.header.origin !== 'subagent') return;
  let mode = ctx.sandboxPolicy.resolve({ session: agent.session }).mode;
  let ancestorId = agent.session.header.parentSession;
  const seen = new Set([agent.id]);
  while (ancestorId !== undefined) {
    const parent = ctx.agents.get(ancestorId);
    if (parent === undefined || seen.has(ancestorId)) {
      mode = 'read-only';
      break;
    }
    seen.add(ancestorId);
    const inherited = ctx.sandboxPolicy.resolve({ session: parent.session }).mode;
    if (modes.indexOf(inherited) < modes.indexOf(mode)) mode = inherited;
    ancestorId = parent.session.header.origin === 'subagent' ? parent.session.header.parentSession : undefined;
    if (parent.session.header.origin === 'subagent' && ancestorId === undefined) mode = 'read-only';
  }
  if (agent.session.header.parentSession === undefined) mode = 'read-only';
  if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== mode) setSandboxMode(agent.session, mode);
  if (ctx.approval.overrideOf(agent.session) !== 'never') setApprovalPolicy(agent.session, 'never');
}

/**
 * Apply current ancestor restrictions before model context and before each tool's file effects.
 * @param ctx - ClawMaster Host plugin context; DSH owns the logged setters and execution mechanisms.
 */
export function applyPermissionGovernance(ctx: Context): void {
  ctx.on('agent/pre-step', ({ agent }, next) => {
    constrainDelegatedPermissions(ctx, agent);
    return next();
  });
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.agent) constrainDelegatedPermissions(ctx, exec.agent);
    return next();
  });
}
