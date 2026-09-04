import { describe, expect, it } from 'vitest';
import { tauriReleaseSteps } from './build-tauri-release.mjs';

describe('Tauri release orchestration', () => {
  it('prepares and smokes the packaged sidecar before every supported bundle', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']]) {
      const steps = tauriReleaseSteps(platform, arch);
      expect(steps[0]).toEqual(['npm', ['run', 'tauri:runtime:prepare']]);
      expect(steps[1]).toEqual(['npm', ['run', 'tauri:runtime:smoke']]);
      expect(steps.some(([command, args]) => command === 'tauri' && args.includes('build'))).toBe(true);
      if (platform === 'darwin') {
        expect(steps).toContainEqual(['tauri', ['build', '--bundles', 'app']]);
        expect(steps).toContainEqual(['npm', ['run', 'tauri:dmg:create']]);
        expect(steps).toContainEqual(['npm', ['run', 'tauri:dmg:optimize']]);
        expect(steps).toContainEqual(['npm', ['run', 'tauri:dmg:verify']]);
      }
    }
    expect(() => tauriReleaseSteps('darwin', 'x64')).toThrow('not packaged');
    expect(() => tauriReleaseSteps('linux', 'x64')).toThrow('not packaged');
  });
});
