/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { createClusteredEnterpriseInfrastructure } from './clusteredInfrastructure.js';

const clusteredEnvironment = {
  CLAWMASTER_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
  CLAWMASTER_POSTGRES_URL: 'postgresql://otto:secret@db.internal/otto',
  CLAWMASTER_ENTERPRISE_CACHE_BACKEND: 'redis',
  CLAWMASTER_REDIS_URL: 'rediss://default:secret@cache.internal:6379',
  CLAWMASTER_ATTACHMENT_OBJECT_STORE: 's3',
  CLAWMASTER_S3_BUCKET: 'otto-private',
  CLAWMASTER_S3_REGION: 'us-east-1',
  CLAWMASTER_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
} as const;

describe('clustered enterprise infrastructure configuration', () => {
  it('rejects a partial legacy dual-read configuration before opening clients', async () => {
    await expect(
      createClusteredEnterpriseInfrastructure({
        environment: {
          ...clusteredEnvironment,
          CLAWMASTER_ATTACHMENT_LEGACY_READ_DIR: 'D:\\legacy-attachments',
        },
      }),
    ).rejects.toThrow(/requires both/i);
  });

  it('forbids a local legacy fallback on a multi-replica deployment', async () => {
    await expect(
      createClusteredEnterpriseInfrastructure({
        environment: {
          ...clusteredEnvironment,
          CLAWMASTER_ENTERPRISE_REPLICA_COUNT: '2',
          CLAWMASTER_ATTACHMENT_LEGACY_READ_DIR: 'D:\\legacy-attachments',
          CLAWMASTER_ATTACHMENT_LEGACY_READ_KEY_FILE: 'D:\\keys\\attachment.key',
        },
      }),
    ).rejects.toThrow(/one migration-window replica/i);
  });

  it('rejects an attachment limit above the desktop E2EE protocol limit', async () => {
    await expect(
      createClusteredEnterpriseInfrastructure({
        environment: {
          ...clusteredEnvironment,
          CLAWMASTER_ATTACHMENT_MAX_BYTES: String(10 * 1024 * 1024 + 17),
        },
      }),
    ).rejects.toThrow(/E2EE protocol limit/i);
  });
});
