#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateDownloadPackageSize } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tauriDmgArtifactName(version, arch) {
  const artifactArch = arch === 'arm64' ? 'aarch64' : arch;
  if (!['aarch64', 'x64'].includes(artifactArch)) {
    throw new Error(`unsupported macOS DMG architecture: ${arch}`);
  }
  return `ClawMaster_${version}_${artifactArch}.dmg`;
}

export function cleanTauriDmgDirectory(directory, {
  pathExists = existsSync,
  readDirectory = readdirSync,
  remove = rmSync,
} = {}) {
  if (!pathExists(directory)) return;
  for (const entry of readDirectory(directory)) {
    if (/^ClawMaster_.*\.dmg$/u.test(entry)) {
      remove(path.join(directory, entry), { force: true });
    }
  }
}

export function createTauriDmg({
  platform = process.platform,
  sourceApp,
  output,
  pathExists = existsSync,
  pathIsDirectory = (candidate) => statSync(candidate).isDirectory(),
  makeTempDirectory = () =>
    mkdtempSync(path.join(os.tmpdir(), 'clawmaster-dmg-create-')),
  makeDirectory = mkdirSync,
  copy = cpSync,
  symlink = symlinkSync,
  remove = rmSync,
  run = execFileSync,
  fileSize = (candidate) => statSync(candidate).size,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error(`DMG creation requires macOS; got ${platform}`);
  }
  if (!sourceApp || !pathExists(sourceApp) || !pathIsDirectory(sourceApp)) {
    throw new Error(`signed ClawMaster.app is missing: ${sourceApp}`);
  }
  if (!output) throw new Error('DMG output path is required');

  const staging = makeTempDirectory();
  try {
    makeDirectory(path.dirname(output), { recursive: true });
    remove(output, { force: true });
    copy(sourceApp, path.join(staging, 'ClawMaster.app'), { recursive: true });
    symlink('/Applications', path.join(staging, 'Applications'), 'dir');
    run(
      'hdiutil',
      [
        'create',
        '-volname',
        'ClawMaster',
        '-srcfolder',
        staging,
        '-fs',
        'APFS',
        '-format',
        'UDZO',
        '-ov',
        output,
      ],
      { stdio: 'inherit' },
    );
    run('hdiutil', ['verify', output], { stdio: 'inherit' });
    const size = evaluateDownloadPackageSize(fileSize(output));
    console.log(
      `[tauri-dmg] created non-interactive image: ${(size.bytes / 1024 / 1024).toFixed(2)} MiB`,
    );
    return { output, ...size };
  } finally {
    remove(staging, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const desktopPackage = JSON.parse(
    readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
  );
  const bundleRoot = path.join(
    desktopRoot,
    'src-tauri',
    'target',
    'release',
    'bundle',
  );
  const dmgDirectory = path.join(bundleRoot, 'dmg');
  cleanTauriDmgDirectory(dmgDirectory);
  createTauriDmg({
    sourceApp: path.join(bundleRoot, 'macos', 'ClawMaster.app'),
    output: path.join(dmgDirectory, tauriDmgArtifactName(desktopPackage.version, process.arch)),
  });
}
