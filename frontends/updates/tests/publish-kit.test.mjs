import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishKit } from '../scripts/publish-kit.mjs';

async function fixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-publish-kit-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const options = { inbox: join(temporary, 'inbox'), root: join(temporary, 'public'), publicKey: join(temporary, 'key.pub') };
    await mkdir(options.inbox);
    await writeFile(options.publicKey, publicKey.export({ type: 'spki', format: 'pem' }));
    const archive = Buffer.from('signed archive fixture');
    const delivery = { schemaVersion: 1, kitVersion: '0.1.0', sourceCommit: 'a'.repeat(40), filename: 'clawmaster-update-kit-0.1.0.zip',
      url: 'https://8.140.52.117/updates/clawmaster/kits/0.1.0/clawmaster-update-kit-0.1.0.zip', sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length };
    const seal = async () => {
      const bytes = Buffer.from(`${JSON.stringify(delivery)}\n`);
      await writeFile(join(options.inbox, 'delivery.json'), bytes);
      await writeFile(join(options.inbox, 'delivery.json.sig'), `${sign(null, bytes, privateKey).toString('base64')}\n`);
    };
    await writeFile(join(options.inbox, delivery.filename), archive);
    await seal();
    await run({ temporary, options, archive, delivery, seal });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('signed kit publication exposes complete files and identical repeats preserve them', async () => fixture(async ({ options, archive, delivery }) => {
  assert.equal((await publishKit(options)).status, 'published');
  assert.deepEqual(await readFile(join(options.root, '0.1.0', delivery.filename)), archive);
  assert.equal((await readdir(join(options.root, '0.1.0'))).length, 4);
  assert.equal((await publishKit(options)).status, 'unchanged');
  assert.deepEqual(await readdir(options.root), ['0.1.0']);
}));

test('tampered ZIP and signature cannot create public state', async () => fixture(async ({ options, archive, delivery }) => {
  await writeFile(join(options.inbox, delivery.filename), 'changed');
  await assert.rejects(publishKit(options), /differs from its signed delivery/);
  await assert.rejects(readdir(options.root), { code: 'ENOENT' });
  await writeFile(join(options.inbox, delivery.filename), archive);
  await writeFile(join(options.inbox, 'delivery.json.sig'), 'invalid');
  await assert.rejects(publishKit(options), /signature verification failed/);
  await assert.rejects(readdir(options.root), { code: 'ENOENT' });
}));

test('signed redirects and replacement versions reject without changing existing bytes', async () => fixture(async ({ options, archive, delivery, seal }) => {
  await publishKit(options);
  delivery.url = 'https://other.invalid/payload.zip';
  await seal();
  await assert.rejects(publishKit(options), /Invalid kit delivery fields/);
  delivery.url = 'https://8.140.52.117/updates/clawmaster/kits/0.1.0/clawmaster-update-kit-0.1.0.zip';
  delivery.sourceCommit = 'b'.repeat(40);
  await seal();
  await assert.rejects(publishKit(options), /immutable kit version already exists/);
  assert.deepEqual(await readFile(join(options.root, '0.1.0', delivery.filename)), archive);
}));

test('redirected ZIP input and publication root leave their destinations untouched', async () => fixture(async ({ temporary, options, delivery }) => {
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  await symlink(outside, options.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishKit(options), /root must be a real directory/);
  assert.deepEqual(await readdir(outside), []);
  const archive = join(options.inbox, delivery.filename);
  const redirected = join(temporary, 'archive');
  await writeFile(redirected, await readFile(archive));
  await rm(archive);
  await symlink(redirected, archive);
  await assert.rejects(publishKit(options), /bounded regular file/);
  assert.deepEqual(await readdir(outside), []);
}));
