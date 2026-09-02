import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('integration adapter journal boundary', () => {
  it('does not publish process-memory journals for durable control or writes', () => {
    const sources = [
      'channelTaskControl.ts',
      'externalCallBoundary.ts',
    ].map((file) => readFileSync(path.resolve(__dirname, file), 'utf8')).join('\n');

    expect(sources).not.toMatch(/export class InMemory\w+Journal/);
  });
});
