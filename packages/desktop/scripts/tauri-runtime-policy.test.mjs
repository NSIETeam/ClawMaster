import { describe, expect, it } from 'vitest';
import {
  assertTauriNodeVersion,
  assertDownloadPackageTarget,
  evaluateDownloadPackageSize,
  evaluateRuntimeSize,
  summarizeRuntimeComponents,
  resolveSqlCipherSource,
  resolveTauriNodeSource,
  resolveTauriRuntimePlatform,
  resolveTauriRuntimeTarget,
} from './tauri-runtime-policy.mjs';

describe('Tauri runtime release policy', () => {
  it('pins the Node sidecar ABI used by packaged native modules', () => {
    expect(assertTauriNodeVersion('24.20.0', '24.20.0')).toBe('24.20.0');
    expect(() => assertTauriNodeVersion('24.19.1', '24.20.0')).toThrow(
      'pinned release toolchain',
    );
  });

  it('maps each productized desktop target to its Tauri sidecar contract', () => {
    expect(resolveTauriRuntimeTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(resolveTauriRuntimePlatform('darwin', 'x64')).toMatchObject({
      target: 'darwin-x64',
      targetTriple: 'x86_64-apple-darwin',
      ripgrepExecutable: 'rg',
    });
    expect(resolveTauriRuntimePlatform('win32', 'x64')).toMatchObject({
      target: 'win32-x64',
      targetTriple: 'x86_64-pc-windows-msvc',
      executableSuffix: '.exe',
      ripgrepExecutable: 'rg.exe',
    });
    expect(() => resolveTauriRuntimeTarget('linux', 'x64')).toThrow('incomplete shell');
  });

  it('requires the canonical verified SQLCipher matrix by default', () => {
    const existing = new Set(['/repo/native/sqlcipher-tauri/darwin-arm64']);
    expect(resolveSqlCipherSource({
      repoRoot: '/repo',
      target: 'darwin-arm64',
      pathExists: (candidate) => existing.has(candidate),
    })).toEqual({
      path: '/repo/native/sqlcipher-tauri/darwin-arm64',
      provenance: 'verified-native-matrix',
    });
  });

  it('never consumes a native binding from an ignored old installer', () => {
    const legacy = '/repo/packages/desktop/release/mac-arm64/ClawMaster.app/Contents/Resources/sqlcipher';
    expect(() => resolveSqlCipherSource({
      repoRoot: '/repo',
      target: 'darwin-arm64',
      pathExists: (candidate) => candidate === legacy,
    })).toThrow('verified SQLCipher runtime missing');
  });

  it('prefers the verified minimal Node runtime and safely falls back locally', () => {
    const files = new Set([
      '/repo/native/node-runtime/darwin-arm64/node',
      '/repo/native/node-runtime/darwin-arm64/manifest.json',
    ]);
    expect(resolveTauriNodeSource({
      repoRoot: '/repo',
      target: 'darwin-arm64',
      hostBinary: '/toolchain/node',
      pathExists: (candidate) => files.has(candidate),
    })).toEqual({
      binary: '/repo/native/node-runtime/darwin-arm64/node',
      manifest: '/repo/native/node-runtime/darwin-arm64/manifest.json',
      provenance: 'verified-minimal-node',
    });
    expect(resolveTauriNodeSource({
      repoRoot: '/repo',
      target: 'win32-x64',
      hostBinary: 'C:\\node.exe',
      pathExists: () => false,
    })).toEqual({
      binary: 'C:\\node.exe',
      manifest: null,
      provenance: 'pinned-release-toolchain',
    });
  });

  it('reserves installer headroom with a 28 MiB runtime target and 32 MiB hard stop', () => {
    expect(evaluateRuntimeSize(28 * 1024 * 1024).withinTarget).toBe(true);
    expect(evaluateRuntimeSize(29 * 1024 * 1024).withinTarget).toBe(false);
    expect(() => evaluateRuntimeSize(33 * 1024 * 1024)).toThrow('hard limit');
  });

  it('reports runtime components in descending order for actionable CI output', () => {
    expect(summarizeRuntimeComponents({
      agent: 3 * 1024 * 1024,
      node: 12 * 1024 * 1024,
      sqlcipher: 1024 * 1024,
    })).toMatchObject({
      totalBytes: 16 * 1024 * 1024,
      withinTarget: true,
      components: [
        { name: 'node', bytes: 12 * 1024 * 1024 },
        { name: 'agent', bytes: 3 * 1024 * 1024 },
        { name: 'sqlcipher', bytes: 1024 * 1024 },
      ],
    });
  });

  it('targets a 30 MiB installer and rejects downloads above 40 MiB', () => {
    expect(evaluateDownloadPackageSize(30 * 1024 * 1024).withinTarget).toBe(true);
    expect(evaluateDownloadPackageSize(31 * 1024 * 1024).withinTarget).toBe(false);
    expect(() => evaluateDownloadPackageSize(41 * 1024 * 1024)).toThrow('hard limit');
    const oversized = evaluateDownloadPackageSize(31 * 1024 * 1024);
    expect(() => assertDownloadPackageTarget(oversized)).toThrow('product target');
    expect(assertDownloadPackageTarget(oversized, { allowOverTarget: true })).toBe(oversized);
  });
});
