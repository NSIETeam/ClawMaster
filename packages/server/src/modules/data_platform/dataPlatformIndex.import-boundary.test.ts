import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('data-platform public library boundary', () => {
  it('does not export executable CLI entry points from the library barrel', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./index.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/Cli\.js/);
  });
});
