import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFormalTauriReleaseGate } from './formal-tauri-release-gate.mjs';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture({ version = '0.0.1', dmgBytes = 1024, workflow } = {}) {
  const root = path.join(
    os.tmpdir(),
    `clawmaster-formal-gate-${process.pid}-${Math.random()}`,
  );
  writeJson(path.join(root, 'package.json'), { version });
  writeJson(path.join(root, 'packages', 'desktop', 'package.json'), {
    version,
  });
  writeJson(
    path.join(root, 'packages', 'desktop', 'src-tauri', 'tauri.conf.json'),
    {
      version,
      productName: 'ClawMaster',
    },
  );
  mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    path.join(root, '.github', 'workflows', 'tauri-preview.yml'),
    workflow ?? `
name: ClawMaster Tauri Release
tags:
  - 'v*.*.*'
name: Publish ClawMaster \${{ github.ref_name }}
tag_name: \${{ github.ref_name }}
npm run release:beta:gate --workspace=packages/desktop
`,
    'utf8',
  );
  const dmg = path.join(
    root,
    'packages',
    'desktop',
    'src-tauri',
    'target',
    'release',
    'bundle',
    'dmg',
    `ClawMaster_${version}_aarch64.dmg`,
  );
  mkdirSync(path.dirname(dmg), { recursive: true });
  writeFileSync(dmg, Buffer.alloc(dmgBytes));
  return root;
}

describe('formal Tauri release gate', () => {
  it('accepts a formal ClawMaster Tauri artifact under the 10 MiB target', () => {
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
    expect(result.failures.join('\n')).toContain(
      'formal release version must not be a preview',
    );
  });

  it('rejects stale or wrongly branded Windows installers', () => {
    const root = makeFixture();
    const nsis = path.join(
      root,
      'packages',
      'desktop',
      'src-tauri',
      'target',
      'release',
      'bundle',
      'nsis',
    );
    mkdirSync(nsis, { recursive: true });
    writeFileSync(path.join(nsis, 'ClawMaster-Setup-0.0.1-win-x64.exe'), 'legacy');
    const result = evaluateFormalTauriReleaseGate({
      root,
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.failures).toEqual([]);
  });

  it('rejects a release workflow that hardcodes an old prerelease', () => {
    const result = evaluateFormalTauriReleaseGate({
      root: makeFixture({
        workflow: `
name: ClawMaster Tauri Release
tags:
  - 'v*.*.*'
name: Publish ClawMaster v0.0.2-beta.1
tag_name: v0.0.2-beta.1
prerelease: true
npm run release:beta:gate --workspace=packages/desktop
`,
      }),
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(result.failures.join('\n')).toContain('must derive release identity from github.ref_name');
  });
});
