#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.resolve(process.argv[2] ?? path.join(
  desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'ClawMaster.app',
));
const contents = path.join(bundle, 'Contents');
const resources = path.join(contents, 'Resources', 'runtime');
const sidecars = [
  path.join(contents, 'MacOS', 'clawmaster-node'),
  path.join(contents, 'MacOS', 'clawmaster-node-aarch64-apple-darwin'),
];
const required = [
  path.join(resources, 'agent', 'server.mjs'),
  path.join(resources, 'agent', 'node_modules', 'better-sqlite3', 'lib', 'database.js'),
  path.join(resources, 'ripgrep', 'rg'),
  path.join(resources, 'sqlcipher', 'better_sqlite3.node'),
  path.join(resources, 'sqlcipher', 'manifest.json'),
];
const missing = required.filter((candidate) => !existsSync(candidate));
if (!sidecars.some((candidate) => existsSync(candidate))) missing.push(sidecars.join(' or '));
if (missing.length) throw new Error(`Tauri bundle is an incomplete shell; missing:\n${missing.join('\n')}`);

const manifest = JSON.parse(readFileSync(required.at(-1), 'utf8'));
if (manifest.target !== 'darwin-arm64') throw new Error(`wrong SQLCipher target: ${manifest.target}`);
if (statSync(path.join(resources, 'ripgrep', 'rg')).size < 1_000_000) {
  throw new Error('packaged ripgrep is unexpectedly small');
}
console.log(`[tauri-bundle] complete Agent runtime verified: ${bundle}`);
