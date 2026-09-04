import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tauriReleaseSteps } from './build-tauri-release.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Tauri release orchestration', () => {
  it('verifies the Rust runtime before every supported bundle', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']]) {
      const steps = tauriReleaseSteps(platform, arch);
      expect(steps[0]).toEqual(['npm', ['run', 'tauri:native:verify']]);
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

  it('does not let direct Tauri commands bypass native runtime tests', () => {
    const config = JSON.parse(readFileSync(
      path.join(desktopRoot, 'src-tauri', 'tauri.conf.json'),
      'utf8',
    ));
    expect(config.build.beforeDevCommand).not.toContain('runtime:prepare');
    expect(config.build.beforeBuildCommand).toContain('tauri:native:verify');
    expect(JSON.stringify(config.bundle.resources)).not.toMatch(/node|agent-payload|sqlcipher/iu);
  });
});
