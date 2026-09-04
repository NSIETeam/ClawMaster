#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTauriRuntimePlatform } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function tauriReleaseSteps(platform, arch) {
  resolveTauriRuntimePlatform(platform, arch);
  const shared = [['npm', ['run', 'tauri:native:verify']]];
  if (platform === 'darwin') {
    return [
      ...shared,
      ['tauri', ['build', '--bundles', 'app']],
      ['npm', ['run', 'tauri:dmg:create']],
      ['npm', ['run', 'tauri:dmg:optimize']],
      ['npm', ['run', 'tauri:dmg:verify']],
    ];
  }
  if (platform === 'win32') {
    const version = process.env.npm_package_version ?? '0.0.0';
    const numericPrerelease = version.match(/^(\d+\.\d+\.\d+)-[^.]+\.(\d+)$/u);
    const msiVersion = numericPrerelease
      ? `${numericPrerelease[1]}-${numericPrerelease[2]}`
      : version;
    return [
      ...shared,
      ['tauri', ['build', '--config', JSON.stringify({ version: msiVersion })]],
    ];
  }
  return [
    ...shared,
    ['tauri', ['build']],
  ];
}

export function buildTauriRelease({ platform = process.platform, arch = process.arch } = {}) {
  const npmCli = process.env.npm_execpath
    ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
  for (const [command, args] of tauriReleaseSteps(platform, arch)) {
    execFileSync(process.execPath, [command === 'tauri' ? tauriCli : npmCli, ...args], {
      cwd: desktopRoot,
      stdio: 'inherit',
    });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  buildTauriRelease();
}
