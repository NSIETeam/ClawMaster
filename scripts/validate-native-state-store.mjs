#!/usr/bin/env node
/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'packages/desktop/src-tauri/src');
const owner = 'native_state_store.rs';
const violations = [];

for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.rs') || entry.name === owner) continue;
  const source = readFileSync(path.join(sourceRoot, entry.name), 'utf8');
  if (/\bsled::(?:open|Config)\b|\.open_tree\s*\(/u.test(source)) {
    violations.push(`${entry.name}: opens a private sled database or tree`);
  }
  if (/CLAWMASTER_[A-Z0-9_]*(?:MASTER_KEY|STATE_KEY)|MASTER_KEY_HEX/u.test(source)) {
    violations.push(`${entry.name}: accepts a master key through ordinary configuration`);
  }
}

const store = readFileSync(path.join(sourceRoot, owner), 'utf8');
for (const tree of [
  'TREE_SESSIONS', 'TREE_EVENTS', 'TREE_MEMORY', 'TREE_INDEX',
  'TREE_ARTIFACT_METADATA', 'TREE_ARTIFACTS', 'TREE_CHECKPOINTS',
  'TREE_USAGE', 'TREE_TOMBSTONES',
]) {
  if (!store.includes(tree)) violations.push(`${owner}: missing ${tree}`);
}
for (const required of [
  'SystemMasterKeyProvider', 'Aes256Gcm', 'put_cas', 'put_once',
  'commit_checkpoint_event', 'put_artifact', 'quarantine',
  '.flush_every_ms(None)',
]) {
  if (!store.includes(required)) violations.push(`${owner}: missing ${required}`);
}

const runtime = readFileSync(path.join(sourceRoot, 'native_runtime.rs'), 'utf8');
if (!runtime.includes('NativeStateStore::open')) {
  violations.push('native_runtime.rs: production state store is not opened');
}
if (!runtime.includes('ModelInvocationGateway::with_usage_ledger')) {
  violations.push('native_runtime.rs: model usage does not use the shared state store');
}
for (const required of [
  'RuntimeIndex::from_state', 'TREE_SESSIONS', 'TREE_EVENTS',
  'message_storage_key', 'LEGACY_STATE_FILE_NAME',
]) {
  if (!runtime.includes(required)) {
    violations.push(`native_runtime.rs: encrypted session migration is missing ${required}`);
  }
}
if (/File::create\([^)]*(?:native-runtime|LEGACY_STATE_FILE_NAME)/u.test(runtime)) {
  violations.push('native_runtime.rs: writes the legacy plaintext runtime state');
}
const knowledge = readFileSync(path.join(sourceRoot, 'native_knowledge.rs'), 'utf8');
for (const required of ['NativeStateStore', 'TREE_MEMORY', 'IMPORT_MARKER_ID']) {
  if (!knowledge.includes(required)) {
    violations.push(`native_knowledge.rs: encrypted knowledge migration is missing ${required}`);
  }
}
if (/fn\s+write\s*\([^)]*KnowledgeEntry/u.test(knowledge)) {
  violations.push('native_knowledge.rs: retains a plaintext knowledge writer');
}

console.log('ClawMaster native state store validation');
if (violations.length > 0) {
  for (const violation of violations) console.error(`FAIL ${violation}`);
  process.exit(1);
}
console.log('Native state ownership, encryption, and usage boundaries are intact.');
