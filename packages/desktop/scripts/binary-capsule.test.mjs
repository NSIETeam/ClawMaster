import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readVerifiedBinaryCapsule,
  writeBinaryCapsule,
} from './binary-capsule.mjs';

describe('binary runtime capsules', () => {
  it('round-trips one signed-by-hash executable contract', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clawmaster-capsule-'));
    try {
      const payload = Buffer.alloc(16 * 1024, 42);
      const created = writeBinaryCapsule({
        bytes: payload,
        directory: root,
        capsuleName: 'tool.br',
        manifestName: 'tool-manifest.json',
        target: 'darwin-arm64',
        metadata: { toolVersion: '1.2.3' },
      });
      const verified = readVerifiedBinaryCapsule({
        capsulePath: created.capsulePath,
        manifestPath: created.manifestPath,
        target: 'darwin-arm64',
        minimumBytes: 1024,
        expectedMetadata: { toolVersion: '1.2.3' },
      });
      expect(verified.bytes.equals(payload)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects changed bytes and mismatched release metadata', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clawmaster-capsule-'));
    try {
      const created = writeBinaryCapsule({
        bytes: Buffer.alloc(16 * 1024, 24),
        directory: root,
        capsuleName: 'tool.br',
        manifestName: 'tool-manifest.json',
        target: 'darwin-arm64',
        metadata: { toolVersion: '1.2.3' },
      });
      expect(() => readVerifiedBinaryCapsule({
        capsulePath: created.capsulePath,
        manifestPath: created.manifestPath,
        target: 'darwin-arm64',
        expectedMetadata: { toolVersion: '9.9.9' },
      })).toThrow('integrity verification');

      const changed = readFileSync(created.capsulePath);
      changed[0] ^= 0xff;
      writeFileSync(created.capsulePath, changed);
      expect(() => readVerifiedBinaryCapsule({
        capsulePath: created.capsulePath,
        manifestPath: created.manifestPath,
        target: 'darwin-arm64',
      })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
