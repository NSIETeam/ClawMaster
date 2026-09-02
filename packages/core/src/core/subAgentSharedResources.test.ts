import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('SubAgent shared resource boundary', () => {
  it('shares the filtered tool registry and releases active chat state on exit', () => {
    const source = readFileSync(path.resolve(__dirname, 'subAgent.ts'), 'utf8');

    expect(source).not.toContain('createSubAgentToolRegistry');
    expect(source).toContain('Promise.resolve(this.toolRegistry)');
    expect(source).toContain('this.executionAbortController.abort()');
    expect(source).toContain('this.subAgentChat?.clearHistory()');
    expect(source).toContain('this.subAgentChat = undefined');
    expect(source).toContain('this.adapter.releaseRetainedData()');
  });

  it('does not account one sub-agent as the entire shared process RSS', () => {
    const taskSource = readFileSync(path.resolve(__dirname, '../tools/task.ts'), 'utf8');

    expect(taskSource).not.toContain('result.memoryUsage?.end.rssBytes');
    expect(taskSource).toContain('estimateAgentOwnedMemoryBytes(result.memoryUsage)');
  });

  it('keeps full prompt request dumps out of normal long-running tasks', () => {
    const source = readFileSync(path.resolve(__dirname, 'subAgent.ts'), 'utf8');
    const requestLogWrites = source.match(/saveRequestLog\(/gu) ?? [];

    expect(requestLogWrites).toHaveLength(1);
    expect(source).toContain('this.config.getDebugMode()');
    expect(source).toContain('const requestLog = this.config.getDebugMode()');
    expect(source).not.toContain('setInterval(');
  });
});
