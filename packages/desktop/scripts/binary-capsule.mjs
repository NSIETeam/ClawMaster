import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';
import path from 'node:path';

const SCHEMA_VERSION = 1;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function writeBinaryCapsule({
  bytes,
  directory,
  capsuleName,
  manifestName,
  target,
  metadata = {},
  quality = 9,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('binary capsule source is empty');
  }
  if (!target || !capsuleName || !manifestName) {
    throw new Error('binary capsule identity is incomplete');
  }
  const compressed = brotliCompressSync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
    },
  });
  const manifest = {
    ...metadata,
    schemaVersion: SCHEMA_VERSION,
    target,
    sha256: sha256(bytes),
    executableBytes: bytes.length,
    compressedBytes: compressed.length,
  };
  mkdirSync(directory, { recursive: true });
  const capsulePath = path.join(directory, capsuleName);
  const manifestPath = path.join(directory, manifestName);
  writeFileSync(capsulePath, compressed);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { capsulePath, manifestPath, manifest };
}

export function readVerifiedBinaryCapsule({
  capsulePath,
  manifestPath,
  target,
  minimumBytes = 1,
  expectedMetadata = {},
}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = brotliDecompressSync(readFileSync(capsulePath));
  const metadataMatches = Object.entries(expectedMetadata)
    .every(([key, value]) => manifest[key] === value);
  if (
    manifest.schemaVersion !== SCHEMA_VERSION
    || manifest.target !== target
    || !Number.isSafeInteger(manifest.executableBytes)
    || manifest.executableBytes < minimumBytes
    || manifest.executableBytes !== bytes.length
    || manifest.compressedBytes !== statSync(capsulePath).size
    || typeof manifest.sha256 !== 'string'
    || manifest.sha256.length !== 64
    || manifest.sha256 !== sha256(bytes)
    || !metadataMatches
  ) {
    throw new Error(`binary capsule failed integrity verification: ${capsulePath}`);
  }
  return { bytes, manifest };
}
