/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 *
 * Authenticated chat-to-task control boundary. Messages produce versioned task
 * intents; they never become shell commands, scripts, or raw RPA actions.
 */

export type ChannelTaskAction =
  | 'status'
  | 'list'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'approve'
  | 'deny'
  | 'takeover'
  | 'propose';

export type ChannelTaskCommand =
  | { action: 'status'; taskId?: string }
  | { action: 'list' }
  | { action: 'pause' | 'resume' | 'cancel' | 'takeover'; taskId: string }
  | { action: 'approve' | 'deny'; approvalId: string }
  | { action: 'propose'; request: string };

export interface ChannelTaskMessageContext {
  provider: 'feishu' | 'lark' | 'wecom';
  installationId: string;
  tenantId: string;
  userId: string;
  deviceId?: string;
  messageId: string;
  receivedAtMs: number;
  signatureVerified: boolean;
  installationConnected: boolean;
  identityBound: boolean;
  identityActive: boolean;
}

export interface ChannelTaskSummary {
  taskId: string;
  title: string;
  state: string;
  updatedAtMs: number;
}

export interface ChannelTaskControlPort {
  list(context: ChannelTaskMessageContext): Promise<ChannelTaskSummary[]>;
  status(taskId: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary | null>;
  pause(taskId: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary>;
  resume(taskId: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary>;
  cancel(taskId: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary>;
  takeOver(taskId: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary>;
  propose(request: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<{
    proposalId: string;
    preview: string;
    requiresApproval: true;
  }>;
  approve(approvalId: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary>;
  deny(approvalId: string, idempotencyKey: string, context: ChannelTaskMessageContext): Promise<void>;
}

export interface ChannelTaskControlPolicy {
  authorize(input: {
    action: ChannelTaskAction;
    taskId?: string;
    approvalId?: string;
    context: ChannelTaskMessageContext;
  }): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}

export type ChannelMessageClaimState = 'processing' | 'committed' | 'unknown_outcome';

export interface ChannelMessageDedupJournal {
  /** Must be atomically persisted across process restarts and server replicas. */
  claim(recordKey: string): 'claimed' | ChannelMessageClaimState;
  complete(recordKey: string): void;
  unknown(recordKey: string): void;
}

export type ChannelTaskControlResult =
  | { ok: true; duplicate: boolean; message: string; data?: unknown }
  | { ok: false; code: 'unauthorized' | 'stale' | 'invalid' | 'denied' | 'unknown_outcome'; message: string };

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,199}$/;
const MAX_MESSAGE_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

function parseArgument(value: string, pattern: RegExp, label: string): string {
  const clean = value.trim();
  if (!pattern.test(clean)) throw new Error(`${label}格式无效`);
  return clean;
}

export function parseChannelTaskCommand(text: string): ChannelTaskCommand {
  const clean = text.trim();
  if (!clean) throw new Error('消息不能为空');
  if (!clean.startsWith('/')) {
    if (clean.length > 4_000) throw new Error('任务请求过长');
    return { action: 'propose', request: clean };
  }
  const [rawCommand = '', ...parts] = clean.split(/\s+/u);
  const command = rawCommand.toLowerCase();
  const argument = parts.join(' ');
  if (command === '/status') {
    return argument ? { action: 'status', taskId: parseArgument(argument, TASK_ID, '任务 ID') } : { action: 'status' };
  }
  if (command === '/tasks') {
    if (argument) throw new Error('/tasks 不接受额外参数');
    return { action: 'list' };
  }
  if (['/pause', '/resume', '/cancel', '/takeover'].includes(command)) {
    return {
      action: command.slice(1) as 'pause' | 'resume' | 'cancel' | 'takeover',
      taskId: parseArgument(argument, TASK_ID, '任务 ID'),
    };
  }
  if (command === '/approve' || command === '/deny') {
    return {
      action: command.slice(1) as 'approve' | 'deny',
      approvalId: parseArgument(argument, APPROVAL_ID, '审批 ID'),
    };
  }
  throw new Error('不支持的 ClawMaster 控制命令');
}

function targetOf(command: ChannelTaskCommand): { taskId?: string; approvalId?: string } {
  if ('taskId' in command) return command.taskId ? { taskId: command.taskId } : {};
  if ('approvalId' in command) return { approvalId: command.approvalId };
  return {};
}

export class ChannelTaskControlGateway {
  constructor(
    private readonly port: ChannelTaskControlPort,
    private readonly policy: ChannelTaskControlPolicy,
    private readonly journal: ChannelMessageDedupJournal,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(text: string, context: ChannelTaskMessageContext): Promise<ChannelTaskControlResult> {
    if (!context.signatureVerified || !context.installationConnected
      || !context.identityBound || !context.identityActive
      || !context.tenantId.trim() || !context.userId.trim()) {
      return { ok: false, code: 'unauthorized', message: '当前聊天身份没有控制 ClawMaster 的权限。' };
    }
    const age = this.now() - context.receivedAtMs;
    if (age > MAX_MESSAGE_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
      return { ok: false, code: 'stale', message: '这条控制消息已经过期，请重新发送。' };
    }
    let command: ChannelTaskCommand;
    try {
      command = parseChannelTaskCommand(text);
    } catch (error) {
      return { ok: false, code: 'invalid', message: error instanceof Error ? error.message : '控制命令无效' };
    }
    const decision = await this.policy.authorize({
      action: command.action,
      ...targetOf(command),
      context,
    });
    if (!decision.allowed) return { ok: false, code: 'denied', message: decision.reason };

    const idempotencyKey = `channel:${context.provider}:${context.installationId}:${context.messageId}`;
    const claim = this.journal.claim(idempotencyKey);
    if (claim !== 'claimed') {
      if (claim === 'unknown_outcome' || claim === 'processing') {
        return { ok: false, code: 'unknown_outcome', message: '上次操作结果尚未确认，请在任务状态页核对，系统不会自动重做。' };
      }
      return { ok: true, duplicate: true, message: '这条消息已经处理过。' };
    }

    try {
      const result = await this.execute(command, idempotencyKey, context);
      this.journal.complete(idempotencyKey);
      return result;
    } catch {
      this.journal.unknown(idempotencyKey);
      return { ok: false, code: 'unknown_outcome', message: '操作结果无法确认，已停止自动重试，请在桌面端核对。' };
    }
  }

  private async execute(
    command: ChannelTaskCommand,
    idempotencyKey: string,
    context: ChannelTaskMessageContext,
  ): Promise<ChannelTaskControlResult> {
    switch (command.action) {
      case 'list': {
        const tasks = await this.port.list(context);
        return { ok: true, duplicate: false, message: `当前有 ${tasks.length} 个任务。`, data: tasks };
      }
      case 'status': {
        if (!command.taskId) {
          const tasks = await this.port.list(context);
          return { ok: true, duplicate: false, message: `当前有 ${tasks.length} 个任务。`, data: tasks };
        }
        const task = await this.port.status(command.taskId, context);
        return { ok: true, duplicate: false, message: task ? `${task.title}：${task.state}` : '没有找到这个任务。', data: task };
      }
      case 'pause':
      case 'resume':
      case 'cancel': {
        const task = await this.port[command.action](command.taskId, idempotencyKey, context);
        return { ok: true, duplicate: false, message: `${task.title}：${task.state}`, data: task };
      }
      case 'takeover': {
        const task = await this.port.takeOver(command.taskId, idempotencyKey, context);
        return { ok: true, duplicate: false, message: `${task.title}：${task.state}`, data: task };
      }
      case 'approve': {
        const task = await this.port.approve(command.approvalId, idempotencyKey, context);
        return { ok: true, duplicate: false, message: `审批已记录：${task.title}`, data: task };
      }
      case 'deny':
        await this.port.deny(command.approvalId, idempotencyKey, context);
        return { ok: true, duplicate: false, message: '审批已拒绝。' };
      case 'propose': {
        const proposal = await this.port.propose(command.request, idempotencyKey, context);
        return { ok: true, duplicate: false, message: proposal.preview, data: proposal };
      }
      default:
        throw new Error('Unsupported channel task command.');
    }
  }
}
