import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

const SCHEMA_VERSION = 1;
const MAX_FILES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !path.posix.isAbsolute(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function listFiles(root) {
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`directory capsule rejects symbolic links: ${relative}`);
      }
      if (stats.isDirectory()) visit(absolute, relative);
      else if (stats.isFile()) files.push({ absolute, relative });
      else throw new Error(`directory capsule rejects special files: ${relative}`);
    }
  };
  visit(root);
  return files;
}

export function writeDirectoryCapsule({
  sourceDirectory,
  capsulePath,
  manifestPath,
  target,
  quality = 9,
}) {
  const files = listFiles(sourceDirectory);
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new Error(`directory capsule file count is invalid: ${files.length}`);
  }
  let offset = 0;
  const chunks = [];
  const entries = files.map(({ absolute, relative }) => {
    const bytes = readFileSync(absolute);
    const entry = {
      path: relative,
      offset,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
    offset += bytes.length;
    chunks.push(bytes);
    return entry;
  });
  if (offset > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`directory capsule is too large: ${offset}`);
  }
  const payload = Buffer.concat(chunks, offset);
  const compressed = brotliCompressSync(payload, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
    },
  });
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    target,
    sha256: sha256(payload),
    uncompressedBytes: payload.length,
    compressedBytes: compressed.length,
    files: entries,
  };
  mkdirSync(path.dirname(capsulePath), { recursive: true });
  writeFileSync(capsulePath, compressed);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readDirectoryCapsuleManifest({ capsulePath, manifestPath, target }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== SCHEMA_VERSION
    || manifest.target !== target
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0
    || manifest.files.length > MAX_FILES
    || !Number.isSafeInteger(manifest.uncompressedBytes)
    || manifest.uncompressedBytes < 1
    || manifest.uncompressedBytes > MAX_UNCOMPRESSED_BYTES
    || manifest.compressedBytes !== statSync(capsulePath).size
    || typeof manifest.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(manifest.sha256)
  ) {
    throw new Error(`directory capsule failed integrity verification: ${capsulePath}`);
  }
  let expectedOffset = 0;
  const paths = new Set();
  for (const entry of manifest.files) {
    if (
      !safeRelativePath(entry.path)
      || paths.has(entry.path)
      || entry.offset !== expectedOffset
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || entry.offset + entry.bytes > manifest.uncompressedBytes
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`directory capsule entry is invalid: ${String(entry.path)}`);
    }
    paths.add(entry.path);
    expectedOffset += entry.bytes;
  }
  if (expectedOffset !== manifest.uncompressedBytes) {
    throw new Error('directory capsule entries do not cover the payload');
  }
  return manifest;
}

export function readVerifiedDirectoryCapsule({ capsulePath, manifestPath, target }) {
  const manifest = readDirectoryCapsuleManifest({ capsulePath, manifestPath, target });
  const payload = brotliDecompressSync(readFileSync(capsulePath));
  if (manifest.uncompressedBytes !== payload.length || manifest.sha256 !== sha256(payload)) {
    throw new Error(`directory capsule failed integrity verification: ${capsulePath}`);
  }
  for (const entry of manifest.files) {
    const bytes = payload.subarray(entry.offset, entry.offset + entry.bytes);
    if (entry.sha256 !== sha256(bytes)) {
      throw new Error(`directory capsule entry hash mismatch: ${entry.path}`);
    }
  }
  return { manifest, payload };
}

function materializedDirectoryIsValid(directory, manifest) {
  if (!existsSync(directory)) return false;
  try {
    const actual = listFiles(directory).map((entry) => entry.relative);
    const expected = manifest.files.map((entry) => entry.path);
    if (actual.length !== expected.length
      || actual.some((relative, index) => relative !== expected[index])) {
      return false;
    }
    return manifest.files.every((entry) => {
      const candidate = path.join(directory, ...entry.path.split('/'));
      const bytes = readFileSync(candidate);
      return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
    });
  } catch {
    return false;
  }
}

export function materializeDirectoryCapsule({
  capsulePath,
  manifestPath,
  target,
  targetDirectory,
}) {
  // The packaged capsule is verified before first extraction. On subsequent
  // starts, hashing the private cache is enough and avoids Brotli work in the
  // resident startup path.
  const cachedManifest = readDirectoryCapsuleManifest({
    capsulePath,
    manifestPath,
    target,
  });
  if (materializedDirectoryIsValid(targetDirectory, cachedManifest)) {
    return targetDirectory;
  }
  const { manifest, payload } = readVerifiedDirectoryCapsule({
    capsulePath,
    manifestPath,
    target,
  });
  const pending = `${targetDirectory}.${process.pid}.pending`;
  const stale = `${targetDirectory}.${process.pid}.stale`;
  rmSync(pending, { recursive: true, force: true });
  rmSync(stale, { recursive: true, force: true });
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      const destination = path.join(pending, ...entry.path.split('/'));
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(
        destination,
        payload.subarray(entry.offset, entry.offset + entry.bytes),
        { mode: 0o600 },
      );
    }
    if (process.platform !== 'win32') chmodSync(pending, 0o700);
    if (existsSync(targetDirectory)) renameSync(targetDirectory, stale);
    renameSync(pending, targetDirectory);
    rmSync(stale, { recursive: true, force: true });
    return targetDirectory;
  } catch (error) {
    rmSync(pending, { recursive: true, force: true });
    if (!existsSync(targetDirectory) && existsSync(stale)) {
      renameSync(stale, targetDirectory);
    }
    throw error;
  }
}
