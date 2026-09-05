import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..');

describe('historical desktop code contract', () => {
  it('does not restore obsolete Electron boot patches or one-off preview tools', () => {
    const deleted = [
      'build-cjs.mjs',
      'electron-bootstrap.cjs',
      'electron-patched.cjs',
      'dev-live.bat',
      'serve-live.js',
      'serve-preview.cjs',
      'webpack.setup-preview.cjs',
      'preview/setup-preview.tsx',
      'preview/shot.cjs',
      'preview/live.tsx',
      'preview/live-bridge.ts',
      'preview/node-crypto-stub.ts',
      'preview/mock.tsx',
      'webpack.live.cjs',
      'webpack.preview.cjs',
      'scripts/build-green-args.mjs',
      'scripts/distribution-config.mjs',
      'src/main/idle-safety-simulation.ts',
    ];
    expect(deleted.filter((relative) => existsSync(path.join(desktopRoot, relative)))).toEqual([]);
  });

  it('keeps Electron compatibility out of the supported desktop commands', () => {
    const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.scripts.start).toBe('npm run tauri:dev');
    expect(packageJson.scripts.build).toContain('tauri:native:verify');
    expect(packageJson.scripts.dist).toBe('npm run tauri:build');
    expect(packageJson.scripts['dist:dmg:x64']).toBeUndefined();
    expect(packageJson.scripts['legacy:start']).toContain('electron');
    expect(packageJson.scripts['legacy:build']).toContain('legacy:build:main');
    expect(packageJson.scripts['dist:green']).toBeUndefined();
    expect(packageJson.scripts['dist:all']).toBeUndefined();
    expect(packageJson.devDependencies['css-loader']).toBeUndefined();
    expect(packageJson.devDependencies['style-loader']).toBeUndefined();
  });
});
