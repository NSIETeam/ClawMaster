import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_RUNTIME_BUILD_FLAGS,
  NODE_RUNTIME_SOURCE_COMMIT,
  WINDOWS_NODE_RUNTIME_BUILD_FLAGS,
  buildNodeRuntimeManifest,
  nodeRuntimeBuildProfile,
  verifyNodeRuntimeAsset,
} from './tauri-node-runtime-contract.mjs';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'clawmaster-node-runtime-'));
  const binary = path.join(directory, 'node');
  cpSync(process.execPath, binary);
  const target = process.platform === 'win32'
    ? `win32-${process.arch}`
    : `darwin-${process.arch}`;
  const manifest = buildNodeRuntimeManifest({
    binary,
    target,
  });
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, binary, manifest, target };
}

describe('minimal Tauri Node runtime contract', () => {
  it('pins a reduced but feature-complete Node build', () => {
    expect(NODE_RUNTIME_SOURCE_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(NODE_RUNTIME_BUILD_FLAGS).not.toContain('--without-inspector');
    expect(NODE_RUNTIME_BUILD_FLAGS).toContain('--with-intl=small-icu');
    expect(NODE_RUNTIME_BUILD_FLAGS).toContain('--with-icu-locales=en,zh-CN');
    expect(NODE_RUNTIME_BUILD_FLAGS).not.toContain('--without-intl');
    expect(NODE_RUNTIME_BUILD_FLAGS).not.toContain('--without-sqlite');
    expect(NODE_RUNTIME_BUILD_FLAGS).not.toContain('--v8-lite-mode');
    expect(NODE_RUNTIME_BUILD_FLAGS).toContain('--enable-lto');
    expect(WINDOWS_NODE_RUNTIME_BUILD_FLAGS).toContain('small-icu');
    expect(WINDOWS_NODE_RUNTIME_BUILD_FLAGS).not.toContain('clang-cl');
    expect(WINDOWS_NODE_RUNTIME_BUILD_FLAGS).toContain('ltcg');
    expect(WINDOWS_NODE_RUNTIME_BUILD_FLAGS).not.toContain('release');
    expect(nodeRuntimeBuildProfile('win32-x64').id).toBe('node24-windows-small-icu-msvc-ltcg-v3');
  });

  it('verifies the executable hash, ABI and required capabilities', () => {
    const { directory, manifest, target } = fixture();
    const result = verifyNodeRuntimeAsset({
      directory,
      target,
      nodeVersion: process.versions.node,
      hardLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(result.manifest.binary.sha256).toBe(manifest.binary.sha256);
    expect(result.probe).toMatchObject({
      fetch: true,
      https: true,
      inspector: true,
      intl: true,
      sqlite: 'ready',
    });
  }, 20_000);

  it('rejects a modified binary before it reaches packaging', () => {
    const { directory, binary, target } = fixture();
    appendFileSync(binary, 'tampered');
    expect(() => verifyNodeRuntimeAsset({
      directory,
      target,
      nodeVersion: process.versions.node,
      hardLimitBytes: Number.MAX_SAFE_INTEGER,
    })).toThrow('hash or size');
  }, 20_000);
});
