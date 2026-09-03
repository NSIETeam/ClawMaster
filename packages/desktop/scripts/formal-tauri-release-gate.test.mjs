import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFormalTauriReleaseGate } from './formal-tauri-release-gate.mjs';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture({ version = '0.0.1', dmgBytes = 1024 } = {}) {
  const root = path.join(os.tmpdir(), `clawmaster-formal-gate-${process.pid}-${Math.random()}`);
  writeJson(path.join(root, 'package.json'), { version });
  writeJson(path.join(root, 'packages', 'desktop', 'package.json'), { version });
  writeJson(path.join(root, 'packages', 'desktop', 'src-tauri', 'tauri.conf.json'), {
    version,
    productName: 'ClawMaster',
  });
  mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.github', 'workflows', 'tauri-preview.yml'), `
name: Tauri Release Build
tags:
      - 'v*.*.*'
name: Publish ClawMaster Tauri release
npm run release:formal:gate --workspace=packages/desktop
packages/desktop/src/main/self-modification-runtime.test.ts
packages/desktop/src/main/self-modification-candidate-supervisor.test.ts
packages/desktop/src/main/self-modification-task-coordinator.test.ts
packages/desktop/src/main/self-modification-version-registry.test.ts
packages/desktop/src/main/self-modification-controller.test.ts
packages/desktop/src/main/self-modification-ipc.test.ts
packages/desktop/src/main/self-modification-infrastructure.test.ts
`, 'utf8');
  writeFileSync(path.join(root, '.github', 'workflows', 'release.yml'), `
if: github.repository == 'NSIETeam/otto-new'
if: github.repository == 'NSIETeam/otto-new'
if: github.repository == 'NSIETeam/otto-new'
if: github.repository == 'NSIETeam/otto-new'
if: github.repository == 'NSIETeam/otto-new'
if: github.repository == 'NSIETeam/otto-new'
`, 'utf8');
  const dmg = path.join(
    root,
    'packages', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'dmg',
    `ClawMaster_${version}_aarch64.dmg`,
  );
  mkdirSync(path.dirname(dmg), { recursive: true });
  writeFileSync(dmg, Buffer.alloc(dmgBytes));
  return root;
}

describe('formal Tauri release gate', () => {
  it('accepts a formal ClawMaster Tauri artifact under the 30 MiB target', () => {
    const result = evaluateFormalTauriReleaseGate({
      root: makeFixture(),
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(result.failures).toEqual([]);
    expect(result.notes.join('\n')).toContain('dmg size');
  });

  it('rejects preview versions for formal releases', () => {
    const result = evaluateFormalTauriReleaseGate({
      root: makeFixture({ version: '0.0.1-preview' }),
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(result.failures.join('\n')).toContain('formal release version must not be a preview');
  });
});
