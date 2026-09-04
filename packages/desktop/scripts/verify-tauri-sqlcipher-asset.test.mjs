import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEPENDENCY_INSPECTION_MAX_BUFFER_BYTES,
  resolveWindowsDependencyInspector,
  verifyTauriSqlCipherAsset,
} from './verify-tauri-sqlcipher-asset.mjs';

const temporaryDirectories = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture({
  target = 'darwin-arm64',
  cryptoProvider = 'commoncrypto',
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clawmaster-tauri-sqlcipher-'));
  temporaryDirectories.push(root);
  const binding = Buffer.from('portable-native-binding');
  const notices = Buffer.from('SQLCipher BSD-3-Clause\n');
  const sbom = Buffer.from(`${JSON.stringify({
    bomFormat: 'CycloneDX',
    metadata: {
      properties: [
        { name: 'otto:runtime', value: 'node' },
        { name: 'otto:runtimeVersion', value: '24.20.0' },
        { name: 'clawmaster.moduleAbi', value: '137' },
        { name: 'otto:cryptoProvider', value: cryptoProvider },
      ],
    },
    components: [{ name: 'SQLCipher' }, { name: 'better-sqlite3' }],
  })}\n`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'better_sqlite3.node'), binding);
  writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices);
  writeFileSync(path.join(root, 'sbom.cdx.json'), sbom);
  writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify({
    format: 3,
    target,
    runtime: 'node',
    runtimeVersion: '24.20.0',
    toolchain: { moduleAbi: '137', cryptoProvider },
    sha256: hash(binding),
    notices: { path: 'THIRD_PARTY_NOTICES.md', sha256: hash(notices) },
    sbom: { path: 'sbom.cdx.json', sha256: hash(sbom) },
  })}\n`);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Tauri SQLCipher asset verifier', () => {
  it('allows dependency inspection output larger than the Node default buffer', () => {
    expect(DEPENDENCY_INSPECTION_MAX_BUFFER_BYTES).toBeGreaterThan(1024 * 1024);
    expect(DEPENDENCY_INSPECTION_MAX_BUFFER_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('finds the MSYS2 objdump installed below the GitHub runner temp directory', () => {
    const runnerTemp = path.join('D:', 'a', '_temp');
    const expected = path.join(
      runnerTemp,
      'msys64', 'ucrt64', 'bin', 'objdump.exe',
    );
    expect(resolveWindowsDependencyInspector({
      environment: { RUNNER_TEMP: runnerTemp, SystemDrive: 'C:' },
      fileExists: (candidate) => candidate === expected,
    })).toEqual({ command: expected, arguments: ['-p'] });
  });

  it('accepts a pinned CommonCrypto Node binding with complete evidence', () => {
    expect(verifyTauriSqlCipherAsset({
      assetDirectory: fixture(),
      expectedTarget: 'darwin-arm64',
      expectedNodeVersion: '24.20.0',
      expectedModuleAbi: '137',
      dependencyOutput: '\t/System/Library/Frameworks/Security.framework/Security\n',
    }).manifest.runtime).toBe('node');
  });

  it('rejects a machine-local dynamic dependency', () => {
    expect(() => verifyTauriSqlCipherAsset({
      assetDirectory: fixture(),
      expectedTarget: 'darwin-arm64',
      expectedNodeVersion: '24.20.0',
      expectedModuleAbi: '137',
      dependencyOutput: '\t/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib\n',
    })).toThrow('machine-local dynamic dependency');
  });

  it('accepts a Windows binding only when OpenSSL is statically linked', () => {
    const assetDirectory = fixture({
      target: 'win32-x64',
      cryptoProvider: 'openssl-static',
    });
    expect(verifyTauriSqlCipherAsset({
      assetDirectory,
      expectedTarget: 'win32-x64',
      expectedNodeVersion: '24.20.0',
      expectedModuleAbi: '137',
      dependencyOutput: 'KERNEL32.dll\nCRYPT32.dll\n',
    }).manifest.target).toBe('win32-x64');
    expect(() => verifyTauriSqlCipherAsset({
      assetDirectory,
      expectedTarget: 'win32-x64',
      expectedNodeVersion: '24.20.0',
      expectedModuleAbi: '137',
      dependencyOutput: 'libcrypto-3-x64.dll\n',
    })).toThrow('link OpenSSL statically');
  });
});
