/**
 * @license
 * Copyright 2026 ClawMaster contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from './config.js';
import { hasAnyLocalAgent } from '../acp-client/localAgentDetection.js';

vi.mock('../acp-client/localAgentDetection.js', () => ({
  hasAnyLocalAgent: vi.fn(),
  isAgentAvailable: vi.fn(),
}));

const mockedHasAnyLocalAgent = vi.mocked(hasAnyLocalAgent);

describe('Config external agent registration', () => {
  beforeEach(() => {
    mockedHasAnyLocalAgent.mockReset();
  });

  it('does not expose delegation when no external agent is usable', async () => {
    mockedHasAnyLocalAgent.mockResolvedValue(false);
    const config = new Config({
      sessionId: 'no-external-agent',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      coreTools: ['delegate_to_agent', 'check_delegate_status'],
    });

    const registry = await config.createToolRegistry();
    expect(registry.getAllTools()).toEqual([]);
  });

  it('registers the selected delegation tools when an external agent is usable', async () => {
    mockedHasAnyLocalAgent.mockResolvedValue(true);
    const config = new Config({
      sessionId: 'external-agent-ready',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      coreTools: ['delegate_to_agent', 'check_delegate_status'],
    });

    const registry = await config.createToolRegistry();
    expect(registry.getAllTools().map((tool) => tool.name).sort()).toEqual([
      'check_delegate_status',
      'delegate_to_agent',
    ]);
  });
});
