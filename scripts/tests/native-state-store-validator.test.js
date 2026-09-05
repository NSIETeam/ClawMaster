import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('native state store validator', () => {
  it('accepts the checked-in encrypted state ownership boundary', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts/validate-native-state-store.mjs')],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Native state ownership');
  });
});
