import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  materializeDirectoryCapsule,
  readVerifiedDirectoryCapsule,
  writeDirectoryCapsule,
} from './directory-capsule.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'clawmaster-directory-capsule-'));
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'node_modules', 'tool'), { recursive: true });
  writeFileSync(path.join(source, 'server.mjs'), 'export const ready = true;\n');
  writeFileSync(path.join(source, 'node_modules', 'tool', 'index.js'), 'module.exports = 42;\n');
  return {
    root,
    source,
    capsulePath: path.join(root, 'agent.br'),
    manifestPath: path.join(root, 'agent-manifest.json'),
    targetDirectory: path.join(root, 'cache', 'agent'),
  };
}

describe('directory runtime capsules', () => {
  it('preserves package paths and repairs a changed private cache', () => {
    const input = fixture();
    try {
      writeDirectoryCapsule({ ...input, sourceDirectory: input.source, target: 'darwin-arm64' });
      expect(readVerifiedDirectoryCapsule({ ...input, target: 'darwin-arm64' }).manifest.files)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ path: 'server.mjs' }),
          expect.objectContaining({ path: 'node_modules/tool/index.js' }),
        ]));
      const materialized = materializeDirectoryCapsule({ ...input, target: 'darwin-arm64' });
      const server = path.join(materialized, 'server.mjs');
      writeFileSync(server, 'tampered');
      materializeDirectoryCapsule({ ...input, target: 'darwin-arm64' });
      expect(readFileSync(server, 'utf8')).toContain('ready = true');
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  it('rejects symlinks and capsule tampering', () => {
    const input = fixture();
    try {
      symlinkSync(path.join(input.source, 'server.mjs'), path.join(input.source, 'alias.mjs'));
      expect(() => writeDirectoryCapsule({
        ...input,
        sourceDirectory: input.source,
        target: 'darwin-arm64',
      })).toThrow('symbolic links');
      rmSync(path.join(input.source, 'alias.mjs'));
      writeDirectoryCapsule({ ...input, sourceDirectory: input.source, target: 'darwin-arm64' });
      const changed = readFileSync(input.capsulePath);
      changed[0] ^= 0xff;
      writeFileSync(input.capsulePath, changed);
      expect(() => readVerifiedDirectoryCapsule({ ...input, target: 'darwin-arm64' }))
        .toThrow();
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  it('reuses an intact private cache without decompressing the capsule again', () => {
    const input = fixture();
    try {
      writeDirectoryCapsule({ ...input, sourceDirectory: input.source, target: 'darwin-arm64' });
      const materialized = materializeDirectoryCapsule({ ...input, target: 'darwin-arm64' });
      const changed = readFileSync(input.capsulePath);
      changed[0] ^= 0xff;
      writeFileSync(input.capsulePath, changed);
      expect(materializeDirectoryCapsule({ ...input, target: 'darwin-arm64' }))
        .toBe(materialized);
      rmSync(materialized, { recursive: true, force: true });
      expect(() => materializeDirectoryCapsule({ ...input, target: 'darwin-arm64' }))
        .toThrow();
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });
});
