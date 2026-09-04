#!/usr/bin/env node
/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath || 'npm';

function run(label, command, args, env = {}) {
  console.log(`[release-preflight] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('private-state stress benchmark', process.execPath, [
  'scripts/low-resource-multi-agent-benchmark.mjs', '--profile=standard8gb',
]);
run('persistent scheduler execution contract', npm, [
  'exec', '--', 'vitest', 'run', 'packages/core/src/services/recurringTaskRegistry.test.ts',
]);
run('real browser RPA click contract', npm, [
  'run', 'test:e2e', '--workspace=packages/rpa',
], { RUN_RPA_BROWSER_E2E: '1' });
