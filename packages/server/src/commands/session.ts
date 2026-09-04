/**
 * @license
 * Copyright 2025 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话类命令：/compress /init。
 *   - /compress：手动压缩当前会话上下文（与 compress_context 帧同一 core 能力：
 *     ClawMasterClient.tryCompressChat）。
 *   - /init：项目无 OTTO.md 时复用 core AcpCommands.performInit 的分析 prompt，
 *     以 submit_prompt 形态转投给模型跑一轮（真实生成文件的是 agent 本身）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  AcpCommands,
  DEFAULT_CONTEXT_FILENAME,
  LEGACY_CONTEXT_FILENAME,
  buildGoalClearMessage,
  type Config,
  type GoalContext,
} from 'clawmaster-core';
import { md, fail, type ServerSlashCommand } from './types.js';

export const compressCommand: ServerSlashCommand = {
  name: 'compress',
  description: '压缩当前会话的上下文（腾出 token 空间）',
  action: async ({ host, sessionId }) => {
    const cfg = host.getConfig(sessionId);
    const client = cfg?.getClawMasterClient?.();
    if (!client) {
      return fail(
        '会话运行时尚未初始化，无法压缩——先发一条消息让会话跑起来。',
      );
    }
    if (client.isCompressionInProgress()) {
      return md('已有压缩任务在进行中，请稍候。');
    }
    const info = await client.tryCompressChat(
      `${sessionId}-slash-compress-${Date.now()}`,
      new AbortController().signal,
      true,
    );
    if (!info) return md('当前上下文较小，无需压缩。');
    return md(
      `已压缩：${info.originalTokenCount.toLocaleString()} → ${info.newTokenCount.toLocaleString()} tokens`,
    );
  },
};

export const initCommand: ServerSlashCommand = {
  name: 'init',
  description: '分析当前目录并生成 CLAWMASTER.md 项目记忆',
  action: async (ctx) => {
    const { host } = ctx;
    const cwd = host.cwd(ctx.sessionId);
    const exists = (await Promise.all(
      [DEFAULT_CONTEXT_FILENAME, LEGACY_CONTEXT_FILENAME].map((filename) =>
        fs.access(path.join(cwd, filename)).then(() => true).catch(() => false)),
    )).some(Boolean);
    const result = AcpCommands.performInit(exists);
    if (result.type === 'message') {
      // 已存在当前或旧版项目记忆：core 返回「未做改动」的说明，如实转达。
      return md(result.content);
    }
    if (result.type === 'submit_prompt') {
      return {
        kind: 'submit_prompt',
        content: result.content,
        note: `已提交项目分析任务：ClawMaster 正在分析 \`${cwd}\` 并生成 ${DEFAULT_CONTEXT_FILENAME}……`,
      };
    }
    // core 目前只会返回 message / submit_prompt；tool 形态在 server 侧无工具管线可挂。
    return fail('/init 返回了 server 侧暂不支持的动作类型。');
  },
};

function buildPlanPrompt(task: string): string {
  return [
    '你现在进入计划模式。',
    '先读取必要上下文并消除不确定性，然后输出可执行、可验证的计划。',
    '在用户明确同意执行前，不修改文件、不运行会改变状态的命令、不发送外部消息。',
    '',
    `需要规划的任务：${task}`,
  ].join('\n');
}

function buildGoalPrompt(task: string): string {
  return [
    '你现在开启【目标驱动模式】(/goal)。',
    '持续推进下面的目标，不要把一份部分结果冒充为完成。',
    '先从目标中提取可验证的达标特征，按计划执行，每个关键结果都要用当前状态证据验收。',
    '遇到阻碍时换用安全的可行路线；需要新授权或用户决策时如实说明。',
    '只有在目标的所有显式要求都已逐项验证后，才能调用 goal_achieved。',
    '',
    `目标：${task}`,
  ].join('\n');
}

export const planCommand: ServerSlashCommand = {
  name: 'plan',
  description: '只调研和制定计划，确认后再执行',
  usage: 'plan <任务> | plan off',
  action: async ({ host, sessionId }, args) => {
    const cfg = host.getConfig(sessionId) ?? await host.ensureConfig?.(sessionId);
    if (!cfg) return fail('会话运行时尚未初始化，请先发一条消息。');
    if (args.toLowerCase() === 'off' || args.toLowerCase() === 'clear') {
      cfg.setPlanModeActive(false);
      return md('已退出计划模式。');
    }
    if (!args) return md(cfg.getPlanModeActive() ? '计划模式已开启。用 `/plan off` 退出。' : '用法：`/plan <任务>`');
    cfg.setPlanModeActive(true);
    return { kind: 'submit_prompt', content: buildPlanPrompt(args), note: '已进入计划模式：本轮只调研和输出计划，不修改系统。' };
  },
};

export const goalCommand: ServerSlashCommand = {
  name: 'goal',
  description: '持续执行并逐项验证一个长程目标',
  usage: 'goal <目标> | goal clear',
  action: async ({ host, sessionId }, args) => {
    const config = host.getConfig(sessionId) ?? await host.ensureConfig?.(sessionId);
    const client = config?.getClawMasterClient?.();
    if (!client) return fail('会话运行时尚未初始化，请先发一条消息。');
    if (args.toLowerCase() === 'clear' || args.toLowerCase() === 'off') {
      client.clearGoalContext();
      return { kind: 'submit_prompt', content: buildGoalClearMessage(), note: '已退出目标驱动模式。' };
    }
    if (!args) return md(client.getGoalContext() ? `目标模式正在运行：${client.getGoalContext()?.task}` : '用法：`/goal <目标>`');
    const originalPrompt = buildGoalPrompt(args);
    const context: GoalContext = { originalPrompt, startedAt: Date.now(), hours: 0, task: args, criteria: '目标中的所有显式要求均有当前状态证据' };
    client.setGoalContext(context);
    return { kind: 'submit_prompt', content: originalPrompt, note: '已进入目标驱动模式；完成前会持续跟踪并验证。' };
  },
};

const MAX_CUSTOM_SYSTEM_PROMPT_LENGTH = 12_000;

async function refreshSystemPrompt(config: Config): Promise<void> {
  const client = config.getClawMasterClient?.();
  if (!client) return;
  await client.updateSystemPromptWithMcpPrompts();
}

export const systemCommand: ServerSlashCommand = {
  name: 'system',
  description: '查看、设置或清除当前会话的系统提示词',
  usage: 'system <提示词> | system show | system clear',
  action: async ({ host, sessionId }, args) => {
    const config = host.getConfig(sessionId) ?? await host.ensureConfig?.(sessionId);
    if (!config) return fail('会话运行时尚未初始化，请先发一条消息。');
    const command = args.trim();
    if (!command || command.toLowerCase() === 'show') {
      const current = config.getCustomSystemPrompt();
      return md(current
        ? `当前会话的自定义系统提示词：\n\n${current}`
        : '当前会话没有自定义系统提示词。用 `/system <提示词>` 设置。');
    }
    if (command.toLowerCase() === 'clear' || command.toLowerCase() === 'off') {
      config.setCustomSystemPrompt('');
      await refreshSystemPrompt(config);
      return md('已清除当前会话的自定义系统提示词。');
    }
    if (command.length > MAX_CUSTOM_SYSTEM_PROMPT_LENGTH) {
      return fail(
        `系统提示词不能超过 ${MAX_CUSTOM_SYSTEM_PROMPT_LENGTH.toLocaleString()} 个字符。`,
      );
    }
    config.setCustomSystemPrompt(command);
    await refreshSystemPrompt(config);
    return md('已应用当前会话的自定义系统提示词；基础安全策略与工具权限保持不变。');
  },
};

export const sessionCommands: ServerSlashCommand[] = [
  planCommand,
  goalCommand,
  systemCommand,
  compressCommand,
  initCommand,
];
