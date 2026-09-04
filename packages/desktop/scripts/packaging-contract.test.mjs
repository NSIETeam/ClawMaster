/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const readText = async (file) => readFile(file, 'utf8');

describe('native-local release contract', () => {
  it('keeps all shipped package versions aligned', async () => {
    const root = await readJson(path.join(repoRoot, 'package.json'));
    const desktop = await readJson(path.join(desktopRoot, 'package.json'));
    const tauri = await readJson(path.join(desktopRoot, 'src-tauri/tauri.conf.json'));
    expect(root.version).toBe('0.0.2-beta.1');
    expect(desktop.version).toBe(root.version);
    expect(tauri.version).toBe(root.version);
  });

  it('contains no production URL or runtime download in the base desktop package', async () => {
    const [config, catalog, policy] = await Promise.all([
      readText(path.join(desktopRoot, 'src-tauri/tauri.conf.json')),
      readText(path.join(desktopRoot, 'src/renderer/moduleCatalog.ts')),
      readText(path.join(desktopRoot, 'scripts/tauri-runtime-policy.mjs')),
    ]);
    expect(config).not.toMatch(/8\.14[01]\./u);
    expect(config).not.toMatch(/47\.116\./u);
    expect(catalog).not.toMatch(/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/u);
    expect(policy).toContain("'native-local'");
    expect(policy).toContain('assertNoRuntimeDownload');
  });

  it('builds only the Tauri release path by default', async () => {
    const pkg = await readJson(path.join(desktopRoot, 'package.json'));
    expect(pkg.scripts.package).toBe('npm run tauri:build');
    expect(pkg.scripts.release).toBe('npm run tauri:build');
    expect(pkg.build).not.toHaveProperty('publish');
    expect(JSON.stringify(pkg)).not.toMatch(/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/u);
  });

  it('uses the supported platform workflow and requires real acceptance gates', async () => {
    const workflow = await readText(path.join(repoRoot, '.github/workflows/tauri-preview.yml'));
    for (const expected of [
      'windows-2022', 'macos-15',
      'release:preflight',
      'cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml native_runtime --lib',
      'softprops/action-gh-release',
      'bundle/nsis/*.exe',
      'bundle/msi/*.msi',
      'bundle/dmg/*_aarch64.dmg',
    ]) expect(workflow).toContain(expected);
    expect(await readText(path.join(repoRoot, 'scripts/release-preflight.mjs')))
      .toContain('low-resource-multi-agent-benchmark.mjs');
    expect(workflow).not.toContain('tauri-node-runtime.yml');
    expect(workflow).not.toContain('sqlcipher-native.yml');
    expect(workflow).not.toContain('path: packages/desktop/src-tauri/target/release/bundle/');
  });

  it('makes the browser RPA E2E non-optional in CI', async () => {
    const workflow = await readText(path.join(repoRoot, '.github/workflows/rpa-browser-e2e.yml'));
    expect(workflow).toContain("RUN_RPA_BROWSER_E2E: '1'");
    expect(workflow).toContain('npm ci');
    expect(workflow).toContain('playwright install --with-deps chromium');
  });
});
