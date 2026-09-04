/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 *
 * Pure attachment-store configuration. Keep this module independent from the
 * AWS SDK so local/offline topology checks do not load the S3 runtime.
 */

export interface AttachmentObjectStoreEnvironment {
  CLAWMASTER_ENTERPRISE_REPLICA_COUNT?: string;
  CLAWMASTER_ATTACHMENT_OBJECT_STORE?: string;
  CLAWMASTER_S3_BUCKET?: string;
  CLAWMASTER_S3_REGION?: string;
  CLAWMASTER_S3_ENDPOINT?: string;
  CLAWMASTER_S3_FORCE_PATH_STYLE?: string;
  CLAWMASTER_S3_BUCKET_PRIVATE_CONFIRMED?: string;
  CLAWMASTER_S3_ALLOW_INSECURE?: string;
  CLAWMASTER_S3_KMS_KEY_ID?: string;
  CLAWMASTER_S3_PRESIGN_TTL_SECONDS?: string;
}

export type AttachmentObjectStoreConfig =
  | { backend: 'encrypted-filesystem' }
  | {
      backend: 's3';
      bucket: string;
      region: string;
      endpoint?: string;
      forcePathStyle: boolean;
      kmsKeyId?: string;
      presignTtlSeconds: number;
    };

function booleanSetting(input: {
  name: string;
  value: string | undefined;
  fallback: boolean;
}): boolean {
  const normalized = input.value?.trim().toLowerCase();
  if (!normalized) return input.fallback;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${input.name} must be true or false`);
}

function boundedInteger(input: {
  name: string;
  value: string | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
}): number {
  if (!input.value?.trim()) return input.fallback;
  const parsed = Number(input.value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < input.minimum ||
    parsed > input.maximum
  ) {
    throw new Error(
      `${input.name} must be an integer from ${input.minimum} to ${input.maximum}`,
    );
  }
  return parsed;
}

function endpointUrl(value: string | undefined, allowInsecure: boolean) {
  if (!value?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CLAWMASTER_S3_ENDPOINT must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('CLAWMASTER_S3_ENDPOINT must be a valid HTTP(S) URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('CLAWMASTER_S3_ENDPOINT must not contain credentials');
  }
  if (parsed.protocol === 'http:' && !allowInsecure) {
    throw new Error(
      'insecure S3 endpoint must be explicitly enabled with CLAWMASTER_S3_ALLOW_INSECURE=true',
    );
  }
  return parsed.toString();
}

export function resolveAttachmentObjectStoreConfig(
  environment: AttachmentObjectStoreEnvironment,
): AttachmentObjectStoreConfig {
  const configured =
    environment.CLAWMASTER_ATTACHMENT_OBJECT_STORE?.trim().toLowerCase() || 'local';
  const replicas = boundedInteger({
    name: 'CLAWMASTER_ENTERPRISE_REPLICA_COUNT',
    value: environment.CLAWMASTER_ENTERPRISE_REPLICA_COUNT,
    fallback: 1,
    minimum: 1,
    maximum: 1_000,
  });
  if (['local', 'encrypted-filesystem'].includes(configured)) {
    if (replicas !== 1) {
      throw new Error(
        'local attachment storage supports one ClawMaster Server replica; use S3 for multiple replicas',
      );
    }
    return { backend: 'encrypted-filesystem' };
  }
  if (configured !== 's3') {
    throw new Error('CLAWMASTER_ATTACHMENT_OBJECT_STORE must be local or s3');
  }

  const privateBucketConfirmed = booleanSetting({
    name: 'CLAWMASTER_S3_BUCKET_PRIVATE_CONFIRMED',
    value: environment.CLAWMASTER_S3_BUCKET_PRIVATE_CONFIRMED,
    fallback: false,
  });
  if (!privateBucketConfirmed) {
    throw new Error(
      'S3 attachment bucket must be private and CLAWMASTER_S3_BUCKET_PRIVATE_CONFIRMED=true must be set',
    );
  }
  const bucket = environment.CLAWMASTER_S3_BUCKET?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('CLAWMASTER_S3_BUCKET must be a valid private bucket name');
  }
  const region = environment.CLAWMASTER_S3_REGION?.trim() ?? '';
  if (!region || region.length > 100 || /\s/.test(region)) {
    throw new Error('CLAWMASTER_S3_REGION is required for S3 attachment storage');
  }
  const allowInsecure = booleanSetting({
    name: 'CLAWMASTER_S3_ALLOW_INSECURE',
    value: environment.CLAWMASTER_S3_ALLOW_INSECURE,
    fallback: false,
  });
  const endpoint = endpointUrl(environment.CLAWMASTER_S3_ENDPOINT, allowInsecure);
  const forcePathStyle = booleanSetting({
    name: 'CLAWMASTER_S3_FORCE_PATH_STYLE',
    value: environment.CLAWMASTER_S3_FORCE_PATH_STYLE,
    fallback: false,
  });
  const presignTtlSeconds = boundedInteger({
    name: 'CLAWMASTER_S3_PRESIGN_TTL_SECONDS',
    value: environment.CLAWMASTER_S3_PRESIGN_TTL_SECONDS,
    fallback: 300,
    minimum: 30,
    maximum: 900,
  });
  const kmsKeyId = environment.CLAWMASTER_S3_KMS_KEY_ID?.trim() || undefined;
  return {
    backend: 's3',
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    ...(kmsKeyId ? { kmsKeyId } : {}),
    presignTtlSeconds,
  };
}
