import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('local enterprise database import boundary', () => {
  it('does not load the data-platform barrel with CLI and clustered-only modules', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./db.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/modules\/data_platform\/index\.js/);
  });
});
