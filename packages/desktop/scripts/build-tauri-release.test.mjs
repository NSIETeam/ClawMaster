import { describe, expect, it } from 'vitest';
import { tauriReleaseSteps } from './build-tauri-release.mjs';

describe('Tauri release orchestration', () => {
  it('uses the in-process native smoke before every supported bundle', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']]) {
      const steps = tauriReleaseSteps(platform, arch);
      expect(steps[0]).toEqual(['npm', ['run', 'tauri:runtime:smoke']]);
      expect(steps.some(([command, args]) => command === 'tauri' && args.includes('build'))).toBe(true);
      expect(steps.some(([command, args]) => args.join(' ').includes('runtime:prepare'))).toBe(false);
    }
  });
});
