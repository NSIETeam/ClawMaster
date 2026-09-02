#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDownloadPackageSize } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findTauriDmgArtifacts(directory, entries = readdirSync(directory)) {
  return entries
    .filter((entry) => entry.endsWith('.dmg') && !entry.endsWith('.optimized.dmg'))
    .sort()
    .map((entry) => path.join(directory, entry));
}

export function optimizeTauriDmg(source, {
  run = execFileSync,
  fileSize = (candidate) => statSync(candidate).size,
} = {}) {
  const optimized = source.replace(/\.dmg$/u, '.optimized.dmg');
  rmSync(optimized, { force: true });
  run('hdiutil', ['convert', source, '-format', 'UDBZ', '-o', optimized], {
    stdio: 'inherit',
  });
  run('hdiutil', ['verify', optimized], { stdio: 'inherit' });
  const before = fileSize(source);
  const after = fileSize(optimized);
  evaluateDownloadPackageSize(after);
  if (after >= before) {
    rmSync(optimized, { force: true });
    return { source, before, after: before, replaced: false };
  }
  renameSync(optimized, source);
  return { source, before, after, replaced: true };
}

export function runTauriDmgOptimization({
  platform = process.platform,
  directory = path.join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'dmg'),
} = {}) {
  if (platform !== 'darwin') {
    console.log(`[tauri-dmg] skipped on ${platform}`);
    return [];
  }
  if (!existsSync(directory)) throw new Error(`Tauri DMG directory is missing: ${directory}`);
  const artifacts = findTauriDmgArtifacts(directory);
  if (!artifacts.length) throw new Error(`No Tauri DMG found in ${directory}`);
  return artifacts.map((artifact) => optimizeTauriDmg(artifact));
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  for (const result of runTauriDmgOptimization()) {
    const before = (result.before / 1024 / 1024).toFixed(2);
    const after = (result.after / 1024 / 1024).toFixed(2);
    console.log(`[tauri-dmg] ${result.replaced ? 'optimized' : 'kept'} ${path.basename(result.source)}: ${before} MiB -> ${after} MiB`);
  }
}
