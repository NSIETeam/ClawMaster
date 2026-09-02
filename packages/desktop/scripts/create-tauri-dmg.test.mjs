import { describe, expect, it, vi } from 'vitest';

import {
  createTauriDmg,
  tauriDmgArtifactName,
} from './create-tauri-dmg.mjs';

describe('non-interactive Tauri DMG creation', () => {
  it('uses the release architecture in the artifact name', () => {
    expect(tauriDmgArtifactName('0.0.1-preview', 'arm64')).toBe(
      'ClawMaster_0.0.1-preview_aarch64.dmg',
    );
    expect(tauriDmgArtifactName('0.0.1-preview', 'x64')).toBe(
      'ClawMaster_0.0.1-preview_x64.dmg',
    );
  });

  it('creates and verifies a DMG without Finder or AppleScript', () => {
    const run = vi.fn();
    const copy = vi.fn();
    const symlink = vi.fn();
    const remove = vi.fn();
    const makeDirectory = vi.fn();

    const result = createTauriDmg({
      platform: 'darwin',
      sourceApp: '/release/ClawMaster.app',
      output: '/release/ClawMaster.dmg',
      pathExists: () => true,
      pathIsDirectory: () => true,
      makeTempDirectory: () => '/tmp/clawmaster-dmg-stage',
      makeDirectory,
      copy,
      symlink,
      remove,
      run,
      fileSize: () => 25 * 1024 * 1024,
    });

    expect(copy).toHaveBeenCalledWith(
      '/release/ClawMaster.app',
      '/tmp/clawmaster-dmg-stage/ClawMaster.app',
      { recursive: true },
    );
    expect(makeDirectory).toHaveBeenCalledWith('/release', {
      recursive: true,
    });
    expect(symlink).toHaveBeenCalledWith(
      '/Applications',
      '/tmp/clawmaster-dmg-stage/Applications',
      'dir',
    );
    expect(run).toHaveBeenNthCalledWith(
      1,
      'hdiutil',
      [
        'create',
        '-volname',
        'ClawMaster',
        '-srcfolder',
        '/tmp/clawmaster-dmg-stage',
        '-fs',
        'APFS',
        '-format',
        'UDZO',
        '-ov',
        '/release/ClawMaster.dmg',
      ],
      { stdio: 'inherit' },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'hdiutil',
      ['verify', '/release/ClawMaster.dmg'],
      { stdio: 'inherit' },
    );
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/osascript|Finder/);
    expect(remove).toHaveBeenLastCalledWith(
      '/tmp/clawmaster-dmg-stage',
      { recursive: true, force: true },
    );
    expect(result.bytes).toBe(25 * 1024 * 1024);
  });
});
