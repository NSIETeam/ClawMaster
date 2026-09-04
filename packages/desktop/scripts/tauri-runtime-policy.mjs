import path from 'node:path';

export const TAURI_PACKAGING_MODES = Object.freeze({
  'micro-bootstrap': Object.freeze({
    targetBytes: 10 * 1024 * 1024,
    hardLimitBytes: 12 * 1024 * 1024,
    embedsLocalExecution: false,
  }),
  'micro-online': Object.freeze({
    targetBytes: 20 * 1024 * 1024,
    hardLimitBytes: 24 * 1024 * 1024,
    embedsLocalExecution: false,
  }),
  'embedded-legacy': Object.freeze({
    targetBytes: 28 * 1024 * 1024,
    hardLimitBytes: 32 * 1024 * 1024,
    embedsLocalExecution: true,
  }),
});

export function resolveTauriPackagingMode(mode = 'micro-online') {
  const policy = TAURI_PACKAGING_MODES[mode];
  if (!policy) {
    throw new Error(`unsupported Tauri packaging mode: ${mode}`);
  }
  return { mode, ...policy };
}

const RUNTIME_PLATFORMS = new Map([
  ['darwin-arm64', {
    target: 'darwin-arm64',
    targetTriple: 'aarch64-apple-darwin',
    binaryArch: 'arm64',
    executableSuffix: '',
    ripgrepExecutable: 'rg',
  }],
  ['darwin-x64', {
    target: 'darwin-x64',
    targetTriple: 'x86_64-apple-darwin',
    binaryArch: 'x86_64',
    executableSuffix: '',
    ripgrepExecutable: 'rg',
  }],
  ['win32-x64', {
    target: 'win32-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    binaryArch: 'x64',
    executableSuffix: '.exe',
    ripgrepExecutable: 'rg.exe',
  }],
]);

export function resolveTauriRuntimePlatform(platform, arch) {
  const resolved = RUNTIME_PLATFORMS.get(`${platform}-${arch}`);
  if (resolved) return { platform, arch, ...resolved };
  throw new Error(
    `ClawMaster Tauri runtime is not yet packaged for ${platform}-${arch}; `
    + 'use a supported release runner instead of producing an incomplete shell',
  );
}

export function resolveTauriRuntimeTarget(platform, arch) {
  return resolveTauriRuntimePlatform(platform, arch).target;
}

export function assertTauriNodeVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `ClawMaster Tauri runtime requires Node ${expected}; got ${actual}. `
      + 'Use the pinned release toolchain so native modules and the sidecar ABI stay reproducible.',
    );
  }
  return actual;
}

export function resolveSqlCipherSource({
  repoRoot,
  target,
  pathExists,
}) {
  const canonical = path.join(repoRoot, 'native', 'sqlcipher-tauri', target);
  if (pathExists(canonical)) {
    return { path: canonical, provenance: 'verified-native-matrix' };
  }
  throw new Error(
    `verified SQLCipher runtime missing: ${canonical}\n`
    + 'Build or download the attested Tauri native matrix before packaging.',
  );
}

export function resolveTauriNodeSource({
  repoRoot,
  target,
  hostBinary,
  pathExists,
}) {
  const directory = path.join(repoRoot, 'native', 'node-runtime', target);
  const binary = path.join(directory, target.startsWith('win32-') ? 'node.exe' : 'node');
  const manifest = path.join(directory, 'manifest.json');
  if (pathExists(binary) && pathExists(manifest)) {
    return {
      binary,
      manifest,
      provenance: 'verified-minimal-node',
    };
  }
  return {
    binary: hostBinary,
    manifest: null,
    provenance: 'pinned-release-toolchain',
  };
}

export function evaluateRuntimeSize(bytes, {
  mode = 'micro-online',
  targetBytes,
  hardLimitBytes,
} = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('runtime size is invalid');
  const policy = resolveTauriPackagingMode(mode);
  targetBytes ??= policy.targetBytes;
  hardLimitBytes ??= policy.hardLimitBytes;
  if (bytes > hardLimitBytes) {
    throw new Error(`Tauri runtime exceeds the ${hardLimitBytes} byte hard limit: ${bytes}`);
  }
  return { bytes, mode, withinTarget: bytes <= targetBytes, targetBytes, hardLimitBytes };
}

export function summarizeRuntimeComponents(componentBytes) {
  const components = Object.entries(componentBytes).map(([name, bytes]) => {
    if (!name || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('runtime component size is invalid');
    }
    return { name, bytes };
  }).sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  const totalBytes = components.reduce((total, component) => total + component.bytes, 0);
  return { ...evaluateRuntimeSize(totalBytes), totalBytes, components };
}

export function evaluateDownloadPackageSize(bytes, {
  targetBytes = 31 * 1024 * 1024,
  hardLimitBytes = 40 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('download size is invalid');
  if (bytes > hardLimitBytes) {
    throw new Error(`Tauri download package exceeds the ${hardLimitBytes} byte hard limit: ${bytes}`);
  }
  return { bytes, withinTarget: bytes <= targetBytes, targetBytes, hardLimitBytes };
}

export function assertDownloadPackageTarget(size, { allowOverTarget = false } = {}) {
  if (!size?.withinTarget && !allowOverTarget) {
    throw new Error(
      `Tauri download package exceeds the ${size?.targetBytes ?? 'unknown'} byte product target: ${size?.bytes ?? 'unknown'}`,
    );
  }
  return size;
}
