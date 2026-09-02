import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('MCPResponseGuard lifecycle', () => {
  it('uses lazy expiry cleanup instead of leaking one timer per tool engine', () => {
    const source = readFileSync(path.resolve(__dirname, 'mcpResponseGuard.ts'), 'utf8');

    expect(source).not.toContain('setInterval(');
    expect(source).not.toContain('startCleanupTask');
    expect(source).not.toContain('globalMCPResponseGuard');
    expect(source).toContain('this.cleanupExpiredTempFiles();');
  });
});
