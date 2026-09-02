import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
    'utf8',
  );
}

describe('attachment object-store configuration boundary', () => {
  it('keeps topology parsing independent from the AWS runtime', () => {
    const topology = source('enterpriseServiceTopology.ts');
    const config = source('attachmentObjectStoreConfig.ts');

    expect(topology).toContain("from './attachmentObjectStoreConfig.js'");
    expect(topology).not.toContain("from './attachmentObjectStoreRuntime.js'");
    expect(config).not.toMatch(/@aws-sdk|s3AttachmentObjectStore/);
  });
});
