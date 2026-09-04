#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.resolve(process.argv[2] ?? path.join(
  desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'ClawMaster.app',
));
const forbidden = /(?:^|[/\\])(?:node(?:[.]exe)?|better_sqlite3[.]node|agent-payload|server-endpoint[.]json)(?:$|[/\\])/iu;

if (!existsSync(bundle)) throw new Error(`Tauri bundle is missing: ${bundle}`);

let totalBytes = 0;
const packagedPaths = [];
const visit = (entry) => {
  const stat = statSync(entry);
  if (stat.isDirectory()) {
    for (const child of readdirSync(entry)) visit(path.join(entry, child));
    return;
  }
  totalBytes += stat.size;
  packagedPaths.push(path.relative(bundle, entry));
};
visit(bundle);

const legacy = packagedPaths.filter((entry) => forbidden.test(entry));
if (legacy.length) {
  throw new Error(`Rust-native bundle contains legacy runtime files:\n${legacy.join('\n')}`);
}

const executable = process.platform === 'win32'
  ? path.join(bundle, 'ClawMaster.exe')
  : path.join(bundle, 'Contents', 'MacOS', 'clawmaster-desktop');
if (!existsSync(executable)) throw new Error(`native executable is missing: ${executable}`);
if (statSync(executable).size < 1_000_000) throw new Error('native executable is unexpectedly small');

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
}

console.log(`[tauri-bundle] Rust-native bundle verified: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
