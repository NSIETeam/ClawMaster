import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('native model gateway validator', () => {
  it('accepts the checked-in native gateway boundary', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts/validate-native-model-gateway.mjs')],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('ModelInvocationGateway');
  });
});
