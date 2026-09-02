#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDownloadPackageTarget, evaluateDownloadPackageSize } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nsisDirectory = path.join(
  desktopRoot,
  'src-tauri', 'target', 'release', 'bundle', 'nsis',
);

export function resolveSingleWindowsInstaller(directory = nsisDirectory) {
  const installers = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .sort()
    .map((name) => path.join(directory, name));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one Tauri NSIS installer, found ${installers.length}`);
  }
  return installers[0];
}

export function verifyTauriWindowsInstaller(installer, {
  testArchive = (file) => execFileSync(
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe')
      : '7z',
    ['t', file],
    { stdio: 'inherit' },
  ),
} = {}) {
  const size = assertDownloadPackageTarget(
    evaluateDownloadPackageSize(statSync(installer).size),
    { allowOverTarget: process.env.CLAWMASTER_ALLOW_OVERSIZE_DOWNLOAD === '1' },
  );
  if (readFileSync(installer).subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error(`Tauri Windows installer is not a PE executable: ${installer}`);
  }
  testArchive(installer);
  const sizeMiB = (size.bytes / 1024 / 1024).toFixed(2);
  console.log(`[tauri-windows] verified NSIS archive and download size: ${sizeMiB} MiB`);
  return { installer, ...size };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  verifyTauriWindowsInstaller(
    process.argv[2]
      ? path.resolve(process.argv[2])
      : resolveSingleWindowsInstaller(),
  );
}
