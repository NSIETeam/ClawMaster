import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../index.js';
import { SubAgentAdapter } from './subAgentAdapter.js';
import type { ToolExecutionContext } from './toolSchedulerAdapter.js';

const context: ToolExecutionContext = {
  agentId: 'adapter-test',
  agentType: 'sub',
  taskDescription: 'bounded tracking',
};

describe('SubAgentAdapter retained data', () => {
  it('bounds command summaries and releases them after the result is built', () => {
    const adapter = new SubAgentAdapter();

    for (let index = 0; index < 250; index++) {
      adapter.onToolStatusChanged(
        `call-${index}`,
        'success',
        {
          request: {
            callId: `call-${index}`,
            name: 'shell',
            args: { command: `command-${index}` },
          },
        } as ToolCall,
        context,
      );
    }

    expect(adapter.getCommandsRun()).toHaveLength(100);
    expect(adapter.getCommandsRun()[0]).toBe('command-150');
    expect(adapter.getCommandsRun().at(-1)).toBe('command-249');

    adapter.releaseRetainedData();
    expect(adapter.getCommandsRun()).toEqual([]);
    expect(adapter.getFilesCreated()).toEqual([]);
  });

  it('does not keep a second private execution log or dead factory path', () => {
    const source = readFileSync(path.resolve(__dirname, 'subAgentAdapter.ts'), 'utf8');

    expect(source).not.toContain('private executionLog');
    expect(source).not.toContain('getExecutionLog()');
    expect(source).not.toContain('createSubAgentAdapter');
  });
});
