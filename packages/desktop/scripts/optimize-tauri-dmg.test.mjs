import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTauriDmgArtifacts } from './optimize-tauri-dmg.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Tauri DMG optimization', () => {
  it('selects only final DMG artifacts in stable order', () => {
    expect(findTauriDmgArtifacts('/release', [
      'notes.txt',
      'ClawMaster_b.dmg',
      'ClawMaster_a.optimized.dmg',
      'ClawMaster_a.dmg',
    ])).toEqual([
      '/release/ClawMaster_a.dmg',
      '/release/ClawMaster_b.dmg',
    ]);
  });

  it('optimizes the DMG before the downloadable artifact is verified', async () => {
    const packageJson = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
    const orchestrator = await readFile(
      path.join(desktopRoot, 'scripts', 'build-tauri-release.mjs'),
      'utf8',
    );
    expect(packageJson.scripts['tauri:build']).toBe(
      'node scripts/build-tauri-release.mjs',
    );
    const build = orchestrator.indexOf("['tauri', ['build', '--bundles', 'app']]");
    const create = orchestrator.indexOf("['npm', ['run', 'tauri:dmg:create']]");
    const optimize = orchestrator.indexOf("['npm', ['run', 'tauri:dmg:optimize']]");
    const verify = orchestrator.indexOf("['npm', ['run', 'tauri:dmg:verify']]");
    expect(build).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(build);
    expect(optimize).toBeGreaterThan(create);
    expect(verify).toBeGreaterThan(optimize);
    expect(packageJson.scripts['tauri:build:local']).toBeUndefined();
    expect(packageJson.scripts['tauri:runtime:prepare:local']).toBeUndefined();
  });
});
