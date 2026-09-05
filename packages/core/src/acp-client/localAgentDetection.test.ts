/**
 * @license
 * Copyright 2026 ClawMaster contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  detectLocalAgents,
  hasAnyLocalAgent,
  isAgentAvailable,
} from './localAgentDetection.js';

describe('localAgentDetection', () => {
  it('requires both the bridge launcher and target agent for default specs', async () => {
    const onlyNpx = await detectLocalAgents({
      lookup: async (binary) => binary === 'npx',
      env: {},
    });
    expect(onlyNpx).toEqual({ claudeCode: false, codex: false });

    const onlyTargets = await detectLocalAgents({
      lookup: async (binary) => binary === 'claude' || binary === 'codex',
      env: {},
    });
    expect(onlyTargets).toEqual({ claudeCode: false, codex: false });
  });

  it('reports each default agent only when its complete launch chain exists', async () => {
    expect(
      await detectLocalAgents({
        lookup: async (binary) => binary === 'npx' || binary === 'codex',
        env: {},
      }),
    ).toEqual({ claudeCode: false, codex: true });

    expect(
      await detectLocalAgents({
        lookup: async (binary) => binary === 'npx' || binary === 'claude',
        env: {},
      }),
    ).toEqual({ claudeCode: true, codex: false });
  });

  it('accepts an executable custom bridge without requiring npx or the target binary', async () => {
    const env = {
      CLAWMASTER_CODEX_ACP_CMD: '/opt/clawmaster/codex-acp --stdio',
    };
    expect(
      await isAgentAvailable(
        'codex',
        async (binary) => binary === '/opt/clawmaster/codex-acp',
        env,
      ),
    ).toBe(true);
  });

  it('rejects a configured bridge when its executable is unavailable', async () => {
    expect(
      await isAgentAvailable(
        'claude-code',
        async () => false,
        { CLAWMASTER_CLAUDE_CODE_ACP_CMD: '/missing/bridge' },
      ),
    ).toBe(false);
  });

  it('fails closed when lookup throws and can summarize aggregate availability', async () => {
    const deps = {
      lookup: async () => {
        throw new Error('probe failed');
      },
      env: {},
    };
    await expect(detectLocalAgents(deps)).resolves.toEqual({
      claudeCode: false,
      codex: false,
    });
    await expect(hasAnyLocalAgent(deps)).resolves.toBe(false);
  });
});
