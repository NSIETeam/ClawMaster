import { describe, expect, it } from 'vitest';
import { resolveFinalizerRuntime } from './finalize-sqlcipher-native-asset.mjs';

const desktopPackage = {
  build: { electronVersion: '43.2.0' },
  tauriRuntime: { nodeVersion: '24.20.0' },
};

describe('SQLCipher finalizer runtime identity', () => {
  it('preserves the Electron release path', () => {
    expect(resolveFinalizerRuntime({
      runtime: 'electron',
      desktopPackage,
      versions: { electron: '43.2.0', node: '24.18.0' },
    })).toEqual({ runtime: 'electron', expectedRuntimeVersion: '43.2.0' });
  });

  it('pins the Tauri Node sidecar ABI source', () => {
    expect(resolveFinalizerRuntime({
      runtime: 'node',
      desktopPackage,
      versions: { node: '24.20.0' },
    })).toEqual({ runtime: 'node', expectedRuntimeVersion: '24.20.0' });
    expect(() => resolveFinalizerRuntime({
      runtime: 'node',
      desktopPackage,
      versions: { node: '24.19.1' },
    })).toThrow('node 24.20.0');
  });
});
