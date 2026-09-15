import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { installUpdater } from '../src/installer.ts';

function signedFixture(overrides = {}) {
  const descriptor = { id: 'updates', packageName: '@clawmaster/dsh-updates', version: '0.1.0', entry: './dist/index.js',
    kind: 'component', activation: 'restart', requiresDshVersion: '0.1.5-rc.2' };
  const blocks = [];
  const files = [
    ['package/package.json', JSON.stringify({ name: descriptor.packageName, version: descriptor.version, type: 'module', peerDependencies: { '@deepseek-ai/cordis': '4.0.2' } })],
    ['package/dist/index.js', 'export const name = "clawmaster-updates"; export function apply() {}\n'],
  ];
  for (const [path, content] of files) {
    const bytes = Buffer.from(content);
    const header = new Header({ path, type: 'File', size: bytes.length, mode: 0o644 });
    header.encode();
    blocks.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const item = { ...descriptor, url: 'https://fixture.invalid/updates/clawmaster/components/artifacts/updates/0.1.0/plugin.tgz',
    sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length, ...overrides };
  const catalog = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [item] }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, catalog, privateKey).toString('base64');
  const trust = { catalogUrl: 'https://fixture.invalid/updates/clawmaster/components/catalog.json', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(url);
    assert.equal(init.redirect, 'error');
    if (url === trust.catalogUrl) return new Response(catalog);
    if (url === `${trust.catalogUrl}.sig`) return new Response(signature);
    if (url === item.url) return new Response(archive);
    assert.fail('unexpected fixture request');
  };
  return { trust, fetchImpl, requests, item };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-installer-'));
  try {
    const runtimeRoot = join(root, 'runtime');
    await mkdir(join(runtimeRoot, 'vendor', 'cordis'), { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.5-rc.2' }));
    await writeFile(join(runtimeRoot, 'vendor', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.2' }));
    const dshHome = join(root, 'home');
    await mkdir(dshHome);
    const sentinel = '# unchanged user configuration\n';
    await writeFile(join(dshHome, 'settings.yaml'), sentinel);
    const options = { runtimeRoot, dshHome, confirmed: false };
    const assertUnchanged = async () => {
      assert.deepEqual(await readdir(dshHome), ['settings.yaml']);
      assert.equal(await readFile(join(dshHome, 'settings.yaml'), 'utf8'), sentinel);
      assert.deepEqual(await readdir(runtimeRoot), ['package.json', 'vendor']);
    };
    await run({ root, options, assertUnchanged });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('installer rejects missing or non-normalized paths before networking or writing state', async () => fixture(async ({ options, assertUnchanged }) => {
  const fetchImpl = async () => assert.fail('invalid runtime paths must not reach the network');
  await assert.rejects(installUpdater({ ...options, dshHome: './home', fetchImpl }), /absolute and normalized/);
  await assert.rejects(installUpdater({ ...options, runtimeRoot: join(options.runtimeRoot, 'missing'), fetchImpl }), /ENOENT/);
  await assertUnchanged();
}));

test('installer checks the actual runtime and Cordis package identities before requesting a channel', async () => fixture(async ({ options, assertUnchanged }) => {
  const fetchImpl = async () => assert.fail('a foreign runtime must not reach the network');
  const packagePath = join(options.runtimeRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  await writeFile(packagePath, JSON.stringify({ name: 'unrelated-project', version: '0.1.5-rc.2' }));
  await assert.rejects(installUpdater({ ...options, fetchImpl }), /deepseek-ai\/dsh-root/);
  await writeFile(packagePath, original);
  await writeFile(join(options.runtimeRoot, 'vendor', 'cordis', 'package.json'), JSON.stringify({ name: 'another-runtime', version: '4.0.2' }));
  await assert.rejects(installUpdater({ ...options, fetchImpl }), /deepseek-ai\/cordis/);
  await assertUnchanged();
}));

test('request failure and cancellation preserve user and runtime directories, including confirmed calls', async () => fixture(async ({ options, assertUnchanged }) => {
  for (const confirmed of [false, true]) {
    await assert.rejects(installUpdater({ ...options, confirmed, fetchImpl: async () => new Response('unavailable', { status: 503 }) }), /HTTP 503/);
    await assert.rejects(installUpdater({ ...options, confirmed, signal: AbortSignal.abort(new Error('cancelled by caller')),
      fetchImpl: async () => assert.fail('an aborted plan must not fetch') }), /cancelled by caller/);
    await assertUnchanged();
  }
}));

test('unauthenticated catalogs never reach archive downloads or filesystem changes', async () => fixture(async ({ options, assertUnchanged }) => {
  const catalog = JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [] });
  for (const confirmed of [false, true]) {
    const urls = [];
    await assert.rejects(installUpdater({ ...options, confirmed, fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.redirect, 'error');
      return new Response(url.endsWith('.sig') ? 'not-a-signature' : catalog);
    } }), /signature encoding/);
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.endsWith('/catalog.json') || url.endsWith('/catalog.json.sig')));
    await assertUnchanged();
  }
}));

test('a catalog signed by a fresh unrelated key cannot replace the pinned bootstrap trust anchor', async () => fixture(async ({ options, assertUnchanged }) => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const catalog = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [] }));
  const signature = sign(null, catalog, privateKey).toString('base64');
  await assert.rejects(installUpdater({ ...options, confirmed: true,
    fetchImpl: async url => new Response(url.endsWith('.sig') ? signature : catalog) }), /signature verification failed/);
  await assertUnchanged();
}));

test('installer metadata has a bounded read and does not persist oversized channel responses', async () => fixture(async ({ options, assertUnchanged }) => {
  await assert.rejects(installUpdater({ ...options, confirmed: true,
    fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), /metadata exceeds/);
  await assertUnchanged();
}));

test('a verified first-install plan remains read-only for existing and absent homes', async () => fixture(async ({ root, options, assertUnchanged }) => {
  const server = signedFixture();
  const plan = await installUpdater({ ...options, fetchImpl: server.fetchImpl }, server.trust);
  assert.equal(plan.status, 'confirmation-required');
  assert.equal(plan.sha256, server.item.sha256);
  assert.equal(server.requests.length, 2);
  await assertUnchanged();
  const absent = join(root, 'not-created');
  const fresh = await installUpdater({ ...options, dshHome: absent, fetchImpl: server.fetchImpl }, server.trust);
  assert.equal(fresh.expectedPatchRevision, plan.expectedPatchRevision);
  await assert.rejects(readdir(absent), { code: 'ENOENT' });
}));

test('confirmed signed installation preserves user settings and profile configuration and mounts only its own row', async () => fixture(async ({ options }) => {
  const profile = join(options.dshHome, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  const original = '# keep personal settings\n- id: existing-plugin\n  config:\n    value: !!js process.env.MY_VALUE # keep comment\n';
  const packageText = '{"private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n';
  await writeFile(join(profile, 'cordis.patch.yml'), original);
  await writeFile(join(profile, 'package.json'), packageText);
  const server = signedFixture();
  const plan = await installUpdater({ ...options, fetchImpl: server.fetchImpl }, server.trust);
  const result = await installUpdater({ ...options, confirmed: true, expectedSha256: plan.sha256,
    expectedPatchRevision: plan.expectedPatchRevision, fetchImpl: server.fetchImpl }, server.trust);
  assert.equal(result.status, 'activation-pending');
  assert.equal(result.rowId, 'clawmaster-update-component-updates');
  assert.ok((await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).startsWith(original));
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), packageText);
  assert.equal(await readFile(join(options.dshHome, 'settings.yaml'), 'utf8'), '# unchanged user configuration\n');
  const plugin = await import(result.entryUrl);
  assert.equal(plugin.name, 'clawmaster-updates');
  assert.deepEqual(await readdir(options.runtimeRoot), ['package.json', 'vendor']);
}));

test('confirmation requires the same authenticated artifact and unchanged profile revision before downloads', async () => fixture(async ({ options, assertUnchanged }) => {
  const server = signedFixture();
  const plan = await installUpdater({ ...options, fetchImpl: server.fetchImpl }, server.trust);
  for (const fields of [{}, { expectedSha256: '0'.repeat(64), expectedPatchRevision: plan.expectedPatchRevision },
    { expectedSha256: plan.sha256, expectedPatchRevision: 'sha256-stale' }]) {
    await assert.rejects(installUpdater({ ...options, confirmed: true, ...fields, fetchImpl: server.fetchImpl }, server.trust), /confirmed installer plan differs/);
    await assertUnchanged();
  }
  assert.ok(server.requests.every(url => url !== server.item.url));
  const profile = join(options.dshHome, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  const edit = '# concurrent edit\n[]\n';
  await writeFile(join(profile, 'cordis.patch.yml'), edit);
  await assert.rejects(installUpdater({ ...options, confirmed: true, expectedSha256: plan.sha256,
    expectedPatchRevision: plan.expectedPatchRevision, fetchImpl: server.fetchImpl }, server.trust), /confirmed installer plan differs/);
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), edit);
  await assert.rejects(readdir(join(options.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
}));

test('managed directory links reject before a signed plan or download can touch their destinations', async () => fixture(async ({ root, options }) => {
  for (const relative of ['clawmaster-updates', 'clawmaster-updates/downloads']) {
    const outside = join(root, `outside-${relative.replaceAll('/', '-')}`);
    await mkdir(outside);
    const path = join(options.dshHome, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(installUpdater({ ...options, confirmed: true, fetchImpl: async () => assert.fail('redirected managed storage must reject before networking') }), /symbolic links/);
      assert.deepEqual(await readdir(outside), []);
    } finally { await unlink(path); }
  }
}));

test('an archive differing from its signed hash never reaches the watched profile', async () => fixture(async ({ options }) => {
  const server = signedFixture({ sha256: '0'.repeat(64) });
  const plan = await installUpdater({ ...options, fetchImpl: server.fetchImpl }, server.trust);
  await assert.rejects(installUpdater({ ...options, confirmed: true, expectedSha256: plan.sha256,
    expectedPatchRevision: plan.expectedPatchRevision, fetchImpl: server.fetchImpl }, server.trust), /SHA-256/);
  await assert.rejects(readdir(join(options.dshHome, 'profiles')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(options.dshHome, 'clawmaster-updates', 'downloads')), []);
}));
