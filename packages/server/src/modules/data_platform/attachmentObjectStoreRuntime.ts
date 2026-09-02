/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

import {
  createLocalAttachmentObjectStore,
  type AttachmentObjectStore,
} from './attachmentObjectStore.js';
import type { EncryptedObjectStore } from './encryptedObjectStore.js';
import {
  createS3AttachmentObjectStore,
  type S3CommandClient,
} from './s3AttachmentObjectStore.js';
import {
  resolveAttachmentObjectStoreConfig,
  type AttachmentObjectStoreConfig,
  type AttachmentObjectStoreEnvironment,
} from './attachmentObjectStoreConfig.js';

export {
  resolveAttachmentObjectStoreConfig,
  type AttachmentObjectStoreConfig,
  type AttachmentObjectStoreEnvironment,
} from './attachmentObjectStoreConfig.js';

export interface AttachmentObjectStoreRuntime {
  config: AttachmentObjectStoreConfig;
  store: AttachmentObjectStore;
  close(): void;
}

export function createAttachmentObjectStoreRuntime(input: {
  environment?: AttachmentObjectStoreEnvironment;
  encryptedStore?: EncryptedObjectStore;
  s3ClientFactory?: (config: S3ClientConfig) => S3CommandClient;
}): AttachmentObjectStoreRuntime {
  const config = resolveAttachmentObjectStoreConfig(
    input.environment ?? process.env,
  );
  if (config.backend === 'encrypted-filesystem') {
    if (!input.encryptedStore) {
      throw new Error('encrypted local attachment store is required');
    }
    return {
      config,
      store: createLocalAttachmentObjectStore({
        encryptedStore: input.encryptedStore,
      }),
      close() {},
    };
  }

  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  };
  const client = input.s3ClientFactory
    ? input.s3ClientFactory(clientConfig)
    : (new S3Client(clientConfig) as unknown as S3CommandClient);
  return {
    config,
    store: createS3AttachmentObjectStore({
      client,
      bucket: config.bucket,
      kmsKeyId: config.kmsKeyId,
      presignTtlSeconds: config.presignTtlSeconds,
    }),
    close() {
      client.destroy?.();
    },
  };
}
