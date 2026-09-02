import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from 'otto-core';
import { goalCommand, initCommand, planCommand, systemCommand } from './session.js';
import { listSlashCommands } from './registry.js';
import type { CommandHost } from './types.js';

function hostWithConfig(config: Partial<Config>): CommandHost {
  return {
    store: {} as CommandHost['store'],
    serverVersion: 'test',
    protocolVersion: 'test',
    uptimeMs: () => 0,
    cwd: () => '/tmp',
    getConfig: () => config as Config,
    currentModel: () => 'test',
    modelInfos: () => [],
    mcpServerInfos: () => [],
    extensionSummaries: async () => [],
  };
}

describe('desktop long-running modes', () => {
  it('publishes plan, goal and system controls to the desktop slash menu', () => {
    const names = listSlashCommands().map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(['plan', 'goal', 'system']));
  });

  it('/plan enables read-only planning and can be cleared', async () => {
    const setPlanModeActive = vi.fn();
    const host = hostWithConfig({
      setPlanModeActive,
      getPlanModeActive: () => false,
    });
    const started = await planCommand.action?.({ host, sessionId: 's1' }, '重构工作区');
    expect(setPlanModeActive).toHaveBeenCalledWith(true);
    expect(started).toMatchObject({ kind: 'submit_prompt' });
    expect(started && 'content' in started ? started.content : '').toContain('不修改文件');

    await planCommand.action?.({ host, sessionId: 's1' }, 'off');
    expect(setPlanModeActive).toHaveBeenLastCalledWith(false);
  });

  it('/plan can lazily initialize a fresh desktop session before the first message', async () => {
    const setPlanModeActive = vi.fn();
    const config = {
      setPlanModeActive,
      getPlanModeActive: () => false,
    } as Partial<Config>;
    const ensureConfig = vi.fn(async () => config as Config);
    const host = {
      ...hostWithConfig({}),
      getConfig: () => undefined,
      ensureConfig,
    };

    const started = await planCommand.action?.(
      { host, sessionId: 'fresh-session' },
      '先分析当前项目',
    );

    expect(ensureConfig).toHaveBeenCalledWith('fresh-session');
    expect(setPlanModeActive).toHaveBeenCalledWith(true);
    expect(started).toMatchObject({ kind: 'submit_prompt' });
  });

  it('/goal registers a durable goal context and clear releases it', async () => {
    const client = {
      setGoalContext: vi.fn(),
      clearGoalContext: vi.fn(),
      getGoalContext: vi.fn(() => null),
    };
    const host = hostWithConfig({ getOttoClient: () => client as never });
    const started = await goalCommand.action?.({ host, sessionId: 's1' }, '交付可安装的应用');
    expect(client.setGoalContext).toHaveBeenCalledWith(expect.objectContaining({
      task: '交付可安装的应用',
      startedAt: expect.any(Number),
    }));
    expect(started).toMatchObject({ kind: 'submit_prompt' });

    await goalCommand.action?.({ host, sessionId: 's1' }, 'clear');
    expect(client.clearGoalContext).toHaveBeenCalledOnce();
  });

  it('/system applies, shows and clears a session system prompt without replacing base rules', async () => {
    let customPrompt = '';
    const refresh = vi.fn(async () => undefined);
    const setCustomSystemPrompt = vi.fn((value: string) => { customPrompt = value; });
    const host = hostWithConfig({
      getCustomSystemPrompt: () => customPrompt,
      setCustomSystemPrompt,
      getOttoClient: () => ({ updateSystemPromptWithMcpPrompts: refresh }) as never,
    });

    const applied = await systemCommand.action?.(
      { host, sessionId: 's1' },
      '优先给出可验证的证据',
    );
    expect(setCustomSystemPrompt).toHaveBeenCalledWith('优先给出可验证的证据');
    expect(refresh).toHaveBeenCalledOnce();
    expect(applied).toMatchObject({ kind: 'markdown', ok: true });

    const shown = await systemCommand.action?.({ host, sessionId: 's1' }, 'show');
    expect(shown && 'markdown' in shown ? shown.markdown : '').toContain('优先给出可验证的证据');

    await systemCommand.action?.({ host, sessionId: 's1' }, 'clear');
    expect(setCustomSystemPrompt).toHaveBeenLastCalledWith('');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('/init presents CLAWMASTER.md while preserving an existing legacy memory file', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-init-'));
    const host = { ...hostWithConfig({}), cwd: () => cwd };

    expect(initCommand.description).toContain('CLAWMASTER.md');
    expect(initCommand.description).not.toContain('OTTO.md');
    const created = await initCommand.action?.({ host, sessionId: 's1' }, '');
    expect(created).toMatchObject({ kind: 'submit_prompt' });
    expect(created && 'content' in created ? created.content : '').toContain('CLAWMASTER.md');

    await writeFile(path.join(cwd, 'OTTO.md'), '# legacy memory', 'utf8');
    const preserved = await initCommand.action?.({ host, sessionId: 's1' }, '');
    expect(preserved).toMatchObject({ kind: 'markdown', ok: true });
    expect(preserved && 'markdown' in preserved ? preserved.markdown : '').toContain('No changes were made');
  });
});
