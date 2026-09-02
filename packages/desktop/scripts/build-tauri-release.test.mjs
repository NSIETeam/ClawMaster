import { describe, expect, it } from 'vitest';
import { tauriReleaseSteps } from './build-tauri-release.mjs';

describe('Tauri release orchestration', () => {
  it('uses one shared runtime build before platform-specific verification', () => {
    const mac = tauriReleaseSteps('darwin', 'arm64');
    const windows = tauriReleaseSteps('win32', 'x64');
    expect(mac.slice(0, 3)).toEqual(windows.slice(0, 3));
    expect(mac[2]).toEqual([
      'npm',
      ['run', 'tauri:runtime:smoke:rpa', '--', '--staging'],
    ]);
    expect(mac[3]).toEqual(['tauri', ['build', '--bundles', 'app']]);
    expect(mac[4]).toEqual(['npm', ['run', 'tauri:dmg:create']]);
    expect(windows[3]).toEqual(['tauri', ['build']]);
    expect(mac.at(-1)).toEqual(['npm', ['run', 'tauri:dmg:verify']]);
    expect(windows.at(-1)).toEqual(['npm', ['run', 'tauri:windows:verify']]);
  });
});
