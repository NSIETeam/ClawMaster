#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const tauriRoot = path.join(desktopRoot, 'src-tauri');
const stagingRoot = path.join(tauriRoot, 'target', 'sidecar-staging');
const runtimeRoot = path.join(stagingRoot, 'runtime');
const agentRoot = path.join(runtimeRoot, 'agent');
const binariesRoot = path.join(stagingRoot, 'binaries');
const targetTriple = 'aarch64-apple-darwin';
const sidecarPath = path.join(binariesRoot, `clawmaster-node-${targetTriple}`);

function run(command, args, cwd = repoRoot) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function requirePath(...candidates) {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`required runtime input missing:\n${candidates.join('\n')}`);
  return found;
}

function prepareNodeSidecar() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`runtime staging requires darwin-arm64; got ${process.platform}-${process.arch}`);
  }
  mkdirSync(binariesRoot, { recursive: true });
  rmSync(sidecarPath, { force: true });
  try {
    run('lipo', [process.execPath, '-thin', 'arm64', '-output', sidecarPath]);
  } catch {
    cpSync(process.execPath, sidecarPath);
  }
}

function prepareAgentBundle() {
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(path.join(agentRoot, 'node_modules'), { recursive: true });
  run(path.join(repoRoot, 'node_modules', '.bin', 'esbuild'), [
    path.join(repoRoot, 'packages', 'server', 'dist', 'bin.js'),
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); if (process.env.CLAWMASTER_RESOURCES_PATH) Object.defineProperty(process, 'resourcesPath', { value: process.env.CLAWMASTER_RESOURCES_PATH });",
    '--external:better-sqlite3', '--external:@otto/native', '--external:pg-native',
    `--outfile=${path.join(agentRoot, 'server.mjs')}`,
  ]);

  const sqliteDestination = path.join(agentRoot, 'node_modules', 'better-sqlite3');
  mkdirSync(sqliteDestination, { recursive: true });
  cpSync(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'lib'), path.join(sqliteDestination, 'lib'), { recursive: true });
  cpSync(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'package.json'), path.join(sqliteDestination, 'package.json'));

  const nativeDestination = path.join(agentRoot, 'node_modules', '@otto', 'native');
  mkdirSync(nativeDestination, { recursive: true });
  cpSync(path.join(repoRoot, 'otto-native', 'dist'), path.join(nativeDestination, 'dist'), { recursive: true });
  cpSync(path.join(repoRoot, 'otto-native', 'package.json'), path.join(nativeDestination, 'package.json'));

  const coreAssets = path.join(agentRoot, 'core-assets');
  mkdirSync(coreAssets, { recursive: true });
  cpSync(path.join(repoRoot, 'packages', 'core', 'skills-seed'), path.join(coreAssets, 'skills-seed'), { recursive: true });
  cpSync(path.join(repoRoot, 'packages', 'core', 'scripts'), path.join(coreAssets, 'scripts'), { recursive: true });
}

function prepareNativeResources() {
  const ripgrep = requirePath(path.join(repoRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'));
  mkdirSync(path.join(runtimeRoot, 'ripgrep'), { recursive: true });
  cpSync(ripgrep, path.join(runtimeRoot, 'ripgrep', 'rg'));

  const sqlCipher = requirePath(
    path.join(repoRoot, 'native', 'sqlcipher', 'darwin-arm64'),
    path.join(desktopRoot, 'release', 'mac-arm64', 'ClawMaster.app', 'Contents', 'Resources', 'sqlcipher'),
  );
  cpSync(sqlCipher, path.join(runtimeRoot, 'sqlcipher'), { recursive: true });
}

function verifyStaging() {
  const required = [
    sidecarPath,
    path.join(agentRoot, 'server.mjs'),
    path.join(agentRoot, 'node_modules', 'better-sqlite3', 'lib', 'database.js'),
    path.join(runtimeRoot, 'ripgrep', 'rg'),
    path.join(runtimeRoot, 'sqlcipher', 'better_sqlite3.node'),
    path.join(runtimeRoot, 'sqlcipher', 'manifest.json'),
  ];
  const missing = required.filter((candidate) => !existsSync(candidate));
  if (missing.length) throw new Error(`incomplete Tauri runtime staging:\n${missing.join('\n')}`);
  const manifest = JSON.parse(readFileSync(required.at(-1), 'utf8'));
  if (manifest.target !== 'darwin-arm64') {
    throw new Error(`expected darwin-arm64 SQLCipher, got ${manifest.target ?? 'unknown'}`);
  }
  console.log(`[tauri-runtime] minimal Agent runtime staged at ${runtimeRoot}`);
}

run('npm', ['run', 'build', '--workspace=otto-core']);
run('npm', ['run', 'build', '--workspace=otto-server']);
run('npm', ['run', 'build', '--workspace=@otto/native']);
prepareNodeSidecar();
prepareAgentBundle();
prepareNativeResources();
verifyStaging();
