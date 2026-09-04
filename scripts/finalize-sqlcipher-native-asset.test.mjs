import { describe, expect, it } from 'vitest';
import { resolveFinalizerRuntime } from './finalize-sqlcipher-native-asset.mjs';

const desktopPackage = {
  build: { electronVersion: '43.2.0' },
};

describe('SQLCipher finalizer runtime identity', () => {
  it('preserves the Electron release path', () => {
    expect(resolveFinalizerRuntime({
      runtime: 'electron',
      desktopPackage,
      versions: { electron: '43.2.0', node: '24.18.0' },
    })).toEqual({ runtime: 'electron', expectedRuntimeVersion: '43.2.0' });
  });

  it('rejects the removed Node sidecar finalization path', () => {
    expect(() => resolveFinalizerRuntime({
      runtime: 'node',
      desktopPackage,
      versions: { node: '24.20.0' },
    })).toThrow('unsupported SQLCipher runtime: node');
  });
});
