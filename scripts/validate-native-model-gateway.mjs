#!/usr/bin/env node
/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 *
 * Keeps native model transport and credentials behind ModelInvocationGateway.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'packages/desktop/src-tauri/src');
const adapter = 'native_models.rs';
const gateway = 'native_model_gateway.rs';
const violations = [];

for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.rs')) continue;
  if (entry.name === adapter || entry.name === gateway) continue;
  const source = readFileSync(path.join(sourceRoot, entry.name), 'utf8');
  const rules = [
    [/\bstream_complete\s*\(/, 'direct model transport call'],
    [/\bcredentials\.get\s*\(\s*&?model\.credential_id/, 'direct model credential read'],
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(source)) violations.push(`${entry.name}: ${reason}`);
  }
}

const runtime = readFileSync(path.join(sourceRoot, 'native_runtime.rs'), 'utf8');
if (/\breqwest::Client\b/.test(runtime)) {
  violations.push('native_runtime.rs: private model HTTP client');
}
for (const purpose of ['InvocationPurpose::Agent', 'InvocationPurpose::Compression', 'InvocationPurpose::SubAgent']) {
  if (!runtime.includes(purpose)) {
    violations.push(`native_runtime.rs: missing gateway purpose ${purpose}`);
  }
}

for (const fixture of ['openai-compatible.sse', 'anthropic.sse', 'gemini.sse']) {
  const fixturePath = path.join(
    root,
    'packages/desktop/src-tauri/fixtures/model-streams',
    fixture,
  );
  try {
    if (!readFileSync(fixturePath, 'utf8').includes('data:')) {
      violations.push(`${fixture}: missing recorded stream data`);
    }
  } catch {
    violations.push(`${fixture}: fixture missing`);
  }
}

console.log('ClawMaster native model gateway validation');
if (violations.length > 0) {
  for (const violation of violations) console.error(`FAIL ${violation}`);
  process.exit(1);
}
console.log('All native production model calls are routed through ModelInvocationGateway.');
