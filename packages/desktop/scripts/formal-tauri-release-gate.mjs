#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDownloadPackageTarget, evaluateDownloadPackageSize } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function collectReleaseAsset({ root, version, platform = process.platform, arch = process.arch }) {
  if (platform === 'darwin') {
    const dmgArch = arch === 'arm64' ? 'aarch64' : arch;
    const dmg = path.join(
      root,
      'packages', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'dmg',
      `ClawMaster_${version}_${dmgArch}.dmg`,
    );
    return { kind: 'dmg', path: dmg };
  }
  if (platform === 'win32') {
    const nsisDirectory = path.join(
      root,
      'packages', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis',
    );
    const installers = existsSync(nsisDirectory)
      ? readdirSync(nsisDirectory)
        .filter((name) => name.endsWith('.exe'))
        .filter((name) => name.includes('ClawMaster') && name.includes(version))
        .sort()
      : [];
    return {
      kind: 'windows-installer',
      path: installers.length === 1 ? path.join(nsisDirectory, installers[0]) : null,
      count: installers.length,
    };
  }
  return { kind: 'unsupported', path: null };
}

export function evaluateFormalTauriReleaseGate({
  root = repoRoot,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const failures = [];
  const notes = [];
  const fail = (message) => failures.push(message);
  const note = (message) => notes.push(message);
  const rootPackage = readJson(path.join(root, 'package.json'));
  const desktopPackage = readJson(path.join(root, 'packages', 'desktop', 'package.json'));
  const tauriConfig = readJson(path.join(root, 'packages', 'desktop', 'src-tauri', 'tauri.conf.json'));
  const version = rootPackage.version;

  if (version !== desktopPackage.version || version !== tauriConfig.version) {
    fail(
      `version mismatch: root=${version}, desktop=${desktopPackage.version}, tauri=${tauriConfig.version}`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    fail(`formal release version must not be a preview/beta/prerelease: ${version}`);
  }
  if (tauriConfig.productName !== 'ClawMaster') {
    fail(`Tauri productName must be ClawMaster: ${tauriConfig.productName}`);
  }

  const tauriWorkflow = readText(path.join(root, '.github', 'workflows', 'tauri-preview.yml'));
  for (const expected of [
    'name: Tauri Release Build',
    'name: Publish ClawMaster Tauri release',
    "tags:\n      - 'v*.*.*'",
    'npm run release:formal:gate --workspace=packages/desktop',
    'packages/desktop/src/main/self-modification-runtime.test.ts',
    'packages/desktop/src/main/self-modification-candidate-supervisor.test.ts',
    'packages/desktop/src/main/self-modification-task-coordinator.test.ts',
    'packages/desktop/src/main/self-modification-version-registry.test.ts',
    'packages/desktop/src/main/self-modification-controller.test.ts',
    'packages/desktop/src/main/self-modification-ipc.test.ts',
    'packages/desktop/src/main/self-modification-infrastructure.test.ts',
  ]) {
    if (!tauriWorkflow.includes(expected)) {
      fail(`Tauri release workflow is missing formal gate coverage: ${expected}`);
    }
  }

  const legacyReleaseWorkflow = readText(path.join(root, '.github', 'workflows', 'release.yml'));
  const legacyGuards = legacyReleaseWorkflow.match(/github\.repository == 'NSIETeam\/otto-new'/gu)?.length ?? 0;
  if (legacyGuards < 6) {
    fail('legacy Otto/Electron release workflow is not fenced away from NSIETeam/ClawMaster');
  }

  const asset = collectReleaseAsset({ root, version, platform, arch });
  if (asset.kind === 'unsupported') {
    note(`no local download artifact required for unsupported platform ${platform}-${arch}`);
  } else if (asset.kind === 'windows-installer' && asset.count !== undefined && asset.count !== 1) {
    fail(`expected exactly one local Windows installer, found ${asset.count}`);
  } else if (!asset.path || !existsSync(asset.path)) {
    fail(`missing local ${asset.kind}: ${asset.path ?? '(not resolved)'}`);
  } else {
    try {
      const size = assertDownloadPackageTarget(evaluateDownloadPackageSize(statSync(asset.path).size));
      note(`${asset.kind} size ${(size.bytes / 1024 / 1024).toFixed(2)} MiB`);
    } catch (error) {
      fail(error.message);
    }
  }

  return { failures, notes };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = evaluateFormalTauriReleaseGate();
  if (result.failures.length) {
    console.error('[formal-tauri-release-gate] failed');
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('[formal-tauri-release-gate] ok');
  for (const message of result.notes) console.log(`[formal-tauri-release-gate] note: ${message}`);
}
