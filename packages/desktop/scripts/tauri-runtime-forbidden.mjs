const FORBIDDEN_RUNTIME_SEGMENTS = new Set([
  '.cache',
  'corepack',
  'electron',
  'electron-builder',
  'eslint',
  'npm',
  'typescript',
  'vitest',
  'webpack',
  'webpack-cli',
]);

const FORBIDDEN_RUNTIME_FILES = new Set([
  'corepack',
  'corepack.cmd',
  'electron',
  'electron-builder',
  'npm',
  'npm-cli.js',
  'npm.cmd',
  'npx',
  'npx-cli.js',
  'npx.cmd',
]);

function normalizeRuntimePath(value) {
  return String(value).replaceAll('\\', '/').split('/').filter(Boolean);
}

function isForbiddenRuntimePath(value) {
  const segments = normalizeRuntimePath(value);
  const basename = segments.at(-1)?.toLowerCase();
  if (basename && FORBIDDEN_RUNTIME_FILES.has(basename)) return true;
  return segments.some((segment, index) => {
    const normalized = segment.toLowerCase();
    if (!FORBIDDEN_RUNTIME_SEGMENTS.has(normalized)) return false;
    const parent = segments.at(index - 1)?.toLowerCase();
    return parent === 'node_modules' || normalized === '.cache';
  });
}

export function assertNoTauriRuntimePackageManagers(paths, {
  label = 'Tauri runtime',
} = {}) {
  const violations = [...paths].filter(isForbiddenRuntimePath).sort();
  if (violations.length) {
    throw new Error(
      `${label} must not package npm, package managers, Electron tooling, or build caches: `
      + violations.join(', '),
    );
  }
  return true;
}
