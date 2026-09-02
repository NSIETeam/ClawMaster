#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTauriDmgArtifacts } from './optimize-tauri-dmg.mjs';
import { assertDownloadPackageTarget, evaluateDownloadPackageSize } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dmgDirectory = path.join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'dmg');

export function resolveSingleTauriDmg(artifacts) {
  if (artifacts.length !== 1) {
    throw new Error(`Expected exactly one final Tauri DMG, found ${artifacts.length}`);
  }
  return artifacts[0];
}

export function assertApplicationsLink(
  link,
  { metadata = lstatSync, readLink = readlinkSync } = {},
) {
  if (!metadata(link).isSymbolicLink() || readLink(link) !== '/Applications') {
    throw new Error('Tauri DMG is missing the canonical Applications link');
  }
}

export function verifyTauriDmg(dmg = resolveSingleTauriDmg(findTauriDmgArtifacts(dmgDirectory))) {
  const size = assertDownloadPackageTarget(
    evaluateDownloadPackageSize(statSync(dmg).size),
    { allowOverTarget: process.env.CLAWMASTER_ALLOW_OVERSIZE_DOWNLOAD === '1' },
  );
  const imageInfo = execFileSync('hdiutil', ['imageinfo', dmg], { encoding: 'utf8' });
  if (!/^Format: UDBZ$/mu.test(imageInfo)) {
    throw new Error(`Tauri DMG is not UDBZ optimized: ${dmg}`);
  }

  const mountpoint = mkdtempSync(path.join(os.tmpdir(), 'clawmaster-dmg-verify-'));
  let attached = false;
  try {
    execFileSync('hdiutil', [
      'attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg,
    ], { stdio: 'inherit' });
    attached = true;
    assertApplicationsLink(path.join(mountpoint, 'Applications'));
    execFileSync(process.execPath, [
      path.join(desktopRoot, 'scripts', 'verify-tauri-bundle.mjs'),
      path.join(mountpoint, 'ClawMaster.app'),
    ], { stdio: 'inherit' });
  } finally {
    if (attached) execFileSync('hdiutil', ['detach', mountpoint], { stdio: 'inherit' });
    rmSync(mountpoint, { recursive: true, force: true });
  }

  const sizeMiB = (size.bytes / 1024 / 1024).toFixed(2);
  console.log(`[tauri-dmg] verified UDBZ download and complete runtime: ${sizeMiB} MiB`);
  return { dmg, ...size };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  verifyTauriDmg(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
