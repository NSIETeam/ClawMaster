import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SignedSelfModificationVersionRegistry } from './self-modification-version-registry.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function candidate(root: string, version: string, contents = Buffer.from('candidate')) {
  const directory = path.join(root, `candidate-${version}`);
  await mkdir(path.join(directory, 'runtime'), { recursive: true });
  await writeFile(path.join(directory, 'runtime', 'clawmaster.bin'), contents);
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    version,
    sourceCommit: 'a'.repeat(40),
    minimumVersion: '0.0.1',
    signingKeyId: 'release-key-1',
    signature: 'signed-payload',
    files: [{ path: 'runtime/clawmaster.bin', bytes: contents.length, sha256: sha256(contents) }],
  }, null, 2)}\n`);
  return directory;
}

describe('SignedSelfModificationVersionRegistry', () => {
  it('verifies and atomically activates a version while retaining the previous version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-version-registry-'));
    const verifySignature = vi.fn(async () => true);
    const registry = new SignedSelfModificationVersionRegistry({ root, verifySignature });
    expect((await registry.activate(await candidate(root, 'candidate-1'))).previousVersion).toBe('none');
    const result = await registry.activate(await candidate(root, 'candidate-2'));
    expect(result).toEqual({ ok: true, previousVersion: 'candidate-1' });
    expect(JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8'))).toMatchObject({ version: 'candidate-2' });
    expect(await readFile(path.join(root, 'versions', 'candidate-1', 'runtime', 'clawmaster.bin'), 'utf8')).toBe('candidate');
    expect(verifySignature).toHaveBeenCalledTimes(4);
  });

  it('rejects a bad hash without changing the active pointer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-version-registry-'));
    const registry = new SignedSelfModificationVersionRegistry({ root, verifySignature: async () => true });
    await registry.activate(await candidate(root, 'stable-1'));
    const bad = await candidate(root, 'bad-1');
    await writeFile(path.join(bad, 'runtime', 'clawmaster.bin'), 'tampered');
    await expect(registry.activate(bad)).resolves.toMatchObject({ ok: false, previousVersion: 'stable-1', requiresRollback: false });
    expect(JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8')).version).toBe('stable-1');
  });

  it('rejects an invalid signature before installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-version-registry-'));
    const registry = new SignedSelfModificationVersionRegistry({ root, verifySignature: async () => false });
    await expect(registry.activate(await candidate(root, 'bad-signature')))
      .resolves.toMatchObject({ ok: false, error: 'candidate signature is invalid' });
  });

  it('rolls the active pointer back only to an installed verified version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-version-registry-'));
    const registry = new SignedSelfModificationVersionRegistry({ root, verifySignature: async () => true });
    await registry.activate(await candidate(root, 'stable-1'));
    await registry.activate(await candidate(root, 'candidate-2'));
    await registry.rollback('stable-1');
    expect(JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8')).version).toBe('stable-1');
    await expect(registry.rollback('../escape')).rejects.toThrow('safe version');
  });
});
