import path from 'node:path';

const MIB = 1024 * 1024;

export const TAURI_PACKAGING_MODES = Object.freeze({
  'native-local': Object.freeze({
    targetBytes: 20 * MIB,
    hardLimitBytes: 32 * MIB,
    embedsLocalExecution: true,
    allowsRuntimeDownload: false,
  }),
});

export const PACKAGE_SIZE_LIMITS = Object.freeze({
  nsis: Object.freeze({ targetBytes: 10 * MIB, hardLimitBytes: 20 * MIB }),
  dmg: Object.freeze({ targetBytes: 10 * MIB, hardLimitBytes: 20 * MIB }),
  deb: Object.freeze({ targetBytes: 10 * MIB, hardLimitBytes: 20 * MIB }),
  appimage: Object.freeze({ targetBytes: 20 * MIB, hardLimitBytes: 60 * MIB }),
});

export function resolveTauriPackagingMode(mode = 'native-local') {
  const policy = TAURI_PACKAGING_MODES[mode];
  if (!policy) throw new Error(`unsupported Tauri packaging mode: ${mode}`);
  return { mode, ...policy };
}

const RUNTIME_PLATFORMS = new Map([
  ['darwin-arm64', { target: 'darwin-arm64', targetTriple: 'aarch64-apple-darwin', binaryArch: 'arm64', executableSuffix: '', ripgrepExecutable: 'rg' }],
  ['win32-x64', { target: 'win32-x64', targetTriple: 'x86_64-pc-windows-msvc', binaryArch: 'x64', executableSuffix: '.exe', ripgrepExecutable: 'rg.exe' }],
]);

export function resolveTauriRuntimePlatform(platform, arch) {
  const resolved = RUNTIME_PLATFORMS.get(`${platform}-${arch}`);
  if (resolved) return { platform, arch, ...resolved };
  throw new Error(`ClawMaster native runtime is not packaged for ${platform}-${arch}`);
}

export function resolveTauriRuntimeTarget(platform, arch) {
  return resolveTauriRuntimePlatform(platform, arch).target;
}

export function assertTauriNodeVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(`ClawMaster Tauri runtime requires Node ${expected}; got ${actual}`);
  }
  return actual;
}

export function resolveSqlCipherSource({ repoRoot, target, pathExists }) {
  const canonical = path.join(repoRoot, 'native', 'sqlcipher-tauri', target);
  if (pathExists(canonical)) return { path: canonical, provenance: 'verified-native-matrix' };
  throw new Error(`verified SQLCipher runtime missing: ${canonical}`);
}

export function resolveTauriNodeSource({ repoRoot, target, hostBinary, pathExists }) {
  const directory = path.join(repoRoot, 'native', 'node-runtime', target);
  const binary = path.join(directory, target.startsWith('win32-') ? 'node.exe' : 'node');
  const manifest = path.join(directory, 'manifest.json');
  if (pathExists(binary) && pathExists(manifest)) {
    return { binary, manifest, provenance: 'verified-minimal-node' };
  }
  return { binary: hostBinary, manifest: null, provenance: 'pinned-release-toolchain' };
}

export function evaluateRuntimeSize(bytes, { mode = 'native-local' } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('runtime size is invalid');
  const policy = resolveTauriPackagingMode(mode);
  if (bytes > policy.hardLimitBytes) {
    throw new Error(`Tauri runtime exceeds the ${policy.hardLimitBytes} byte hard limit: ${bytes}`);
  }
  return {
    bytes,
    mode,
    withinTarget: bytes <= policy.targetBytes,
    targetBytes: policy.targetBytes,
    hardLimitBytes: policy.hardLimitBytes,
  };
}

export function evaluateArtifactSize(bytes, format) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('artifact size is invalid');
  const policy = PACKAGE_SIZE_LIMITS[format];
  if (!policy) throw new Error(`unsupported artifact format: ${format}`);
  if (bytes > policy.hardLimitBytes) {
    throw new Error(`${format} artifact exceeds the ${policy.hardLimitBytes} byte hard limit: ${bytes}`);
  }
  return { bytes, format, withinTarget: bytes <= policy.targetBytes, targetBytes: policy.targetBytes, hardLimitBytes: policy.hardLimitBytes };
}

export function evaluateDownloadPackageSize(bytes, options = {}) {
  return evaluateArtifactSize(bytes, options.format ?? 'nsis');
}

export function assertDownloadPackageTarget(size, { allowOverTarget = false } = {}) {
  if (!size?.withinTarget && !allowOverTarget) {
    throw new Error(`artifact exceeds the ${size?.targetBytes ?? 'unknown'} byte product target: ${size?.bytes ?? 'unknown'}`);
  }
  return size;
}

export function evaluateAgentPrivateBytes(bytes, { hardLimitBytes = MIB } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('agent private state size is invalid');
  if (bytes > hardLimitBytes) {
    throw new Error(`agent private state exceeds the ${hardLimitBytes} byte hard limit: ${bytes}`);
  }
  return { bytes, hardLimitBytes, withinLimit: true };
}

export function assertNoRuntimeDownload(policy = resolveTauriPackagingMode()) {
  if (policy.allowsRuntimeDownload) throw new Error('release runtime must not download runtime payloads');
  return policy;
}

export function summarizeRuntimeComponents(componentBytes, formatOrOptions = 'nsis') {
  const components = Object.entries(componentBytes).map(([name, bytes]) => {
    if (!name || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('runtime component size is invalid');
    return { name, bytes };
  }).sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  const totalBytes = components.reduce((total, component) => total + component.bytes, 0);
  const size = typeof formatOrOptions === 'string'
    ? evaluateArtifactSize(totalBytes, formatOrOptions)
    : evaluateRuntimeSize(totalBytes, formatOrOptions);
  return { ...size, totalBytes, components };
}

export function resolveCapabilityManifestPath(repoRoot) {
  return path.join(repoRoot, 'packages', 'desktop', 'capabilities', 'manifest.json');
}
