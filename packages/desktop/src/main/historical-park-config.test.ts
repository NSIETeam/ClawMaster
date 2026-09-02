import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

describe('desktop park configuration boundary', () => {
  it('keeps the enterprise park API as the only park configuration source', () => {
    const sources = [
      readSource('./index.ts'),
      readSource('../preload/index.ts'),
      readSource('../renderer/components/ParkServicesPlugin.tsx'),
      readSource('../renderer/browserPreviewBridge.ts'),
      readSource('../../../server/src/server.ts'),
    ].join('\n');

    expect(sources).not.toContain('park-services.json');
    expect(sources).not.toContain('parkConfig');
    expect(sources).not.toContain('ParkServicesConfig');
  });
});
