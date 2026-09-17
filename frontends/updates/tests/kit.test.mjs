import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { Header } from 'tar';
import { inspectKit, installKit, nativeKit, repairKit, verifyKit } from '../src/kit.ts';
import { activateComponent, confirmComponentHealth, installComponent, listComponentOperations, maintainRestartComponents,
  mountFirstUpdaterComponent, readComponentPatchRevision, rollbackComponent } from '../src/components.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(value).toString('base64');
// Public four-byte "test" vector from jedisct1/rust-minisign-verify; no test uses a native private key.
const nativeKey = 'untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n';
const nativeSignature = 'untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n';

function archive(version = '0.1.0', name = '@clawmaster/dsh-updates') {
  const files = [['package/package.json', JSON.stringify({ name, version, type: 'module', peerDependencies: { '@deepseek-ai/cordis': '4.0.2' } })],
    ['package/dist/index.js', `export const name="clawmaster-updates"; export const version=${JSON.stringify(version)}; export function apply() {}\n`]];
  const blocks = [];
  for (const [path, content] of files) {
    const bytes = Buffer.from(content);
    const header = new Header({ path, type: 'File', size: bytes.length, mode: 0o644 });
    header.encode();
    blocks.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-portable-kit-'));
  try {
    const kitRoot = join(root, 'kit');
    await mkdir(join(kitRoot, 'payloads'), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const trust = { componentPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), catalogUrl: 'https://fixture.invalid/updates/clawmaster/components/catalog.json',
      nativePublicKey: encode(nativeKey), nativeManifestUrl: 'https://fixture.invalid/updates/clawmaster/latest.json',
      fetchImpl: async () => assert.fail('offline kit operations must not fetch') };
    const payloadPath = 'payloads/clawmaster-dsh-updates-0.1.0.tgz';
    const component = { id: 'updates', packageName: '@clawmaster/dsh-updates', version: '0.1.0', kind: 'component', entry: './dist/index.js', activation: 'restart', requiresDshVersion: '0.1.5-rc.2',
      url: 'https://fixture.invalid/updates/clawmaster/components/artifacts/updates/0.1.0/clawmaster-dsh-updates-0.1.0.tgz', sha256: hash(archive()), size: archive().length };
    const catalog = { schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [component] };
    await writeFile(join(kitRoot, 'update-kit.mjs'), '// Fixture utility; never executed.\n');
    await writeFile(join(kitRoot, payloadPath), archive());
    const signCatalog = async () => {
      const bytes = Buffer.from(JSON.stringify(catalog));
      await writeFile(join(kitRoot, 'payloads/catalog.json'), bytes);
      await writeFile(join(kitRoot, 'payloads/catalog.json.sig'), sign(null, bytes, privateKey).toString('base64'));
    };
    await signCatalog();
    const paths = ['update-kit.mjs', 'payloads/catalog.json', 'payloads/catalog.json.sig', payloadPath];
    const resignManifest = async transform => {
      const files = await Promise.all(paths.map(async path => { const bytes = await readFile(join(kitRoot, path)); return { path, size: bytes.length, sha256: hash(bytes) }; }));
      const manifest = { schemaVersion: 1, kitVersion: '0.1.0', sourceCommit: 'a'.repeat(40), files };
      transform?.(manifest);
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(join(kitRoot, 'kit-manifest.json'), bytes);
      await writeFile(join(kitRoot, 'kit-manifest.json.sig'), sign(null, bytes, privateKey).toString('base64'));
    };
    await resignManifest();
    const runtimeRoot = join(root, 'runtime');
    await mkdir(join(runtimeRoot, 'vendor', 'cordis'), { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-root","version":"0.1.5-rc.2"}');
    await writeFile(join(runtimeRoot, 'vendor', 'cordis', 'package.json'), '{"name":"@deepseek-ai/cordis","version":"4.0.2"}');
    const dshHome = join(root, 'home');
    const profile = join(dshHome, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    const patch = join(profile, 'cordis.patch.yml');
    const profileBytes = '# user profile comment\n[]\n';
    await writeFile(patch, profileBytes);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    await writeFile(join(dshHome, 'settings.yaml'), 'model: keep-existing-model\n');
    await mkdir(join(dshHome, 'sessions'));
    await writeFile(join(dshHome, 'sessions', 'fixture.jsonl'), '{"session":"keep-existing-data"}\n');
    const compatibility = { dshHome, runtimeRoot, platform: process.platform };
    const options = { kitRoot, compatibility, confirmed: false };
    const confirm = async extra => {
      const plan = await inspectKit(options, trust);
      return installKit({ ...options, confirmed: true, expectedSha256: plan.component.sha256, expectedPatchRevision: plan.patchRevision, ...extra }, trust);
    };
    const unchanged = async () => {
      assert.equal(await readFile(patch, 'utf8'), profileBytes);
      assert.equal(await readFile(join(dshHome, 'settings.yaml'), 'utf8'), 'model: keep-existing-model\n');
      assert.equal(await readFile(join(dshHome, 'sessions', 'fixture.jsonl'), 'utf8'), '{"session":"keep-existing-data"}\n');
    };
    await run({ root, options, trust, component, catalog, payloadPath, patch, profile, profileBytes, resignManifest, signCatalog, confirm, unchanged });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('authenticated offline inspection performs no writes and retains the exact verified archive bytes', async () => fixture(async ({ options, trust, component, unchanged }) => {
  const kit = await verifyKit(options.kitRoot, trust);
  assert.equal(hash(kit.archiveBytes), component.sha256);
  const plan = await inspectKit(options, trust);
  assert.equal(plan.status, 'supported-component-bootstrap');
  assert.equal(plan.component.sha256, component.sha256);
  assert.ok(plan.patchRevision.startsWith('sha256-'));
  assert.deepEqual(await installKit(options, trust), plan);
  await assert.rejects(readdir(join(options.compatibility.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
  await unchanged();
}));

test('a wrong kit signer, tampered signed file and tampered inner catalog all reject before writes', async () => fixture(async ({ options, trust, payloadPath, resignManifest, unchanged }) => {
  const { publicKey } = generateKeyPairSync('ed25519');
  await assert.rejects(verifyKit(options.kitRoot, { ...trust, componentPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), /kit signature/);
  const payload = await readFile(join(options.kitRoot, payloadPath));
  await writeFile(join(options.kitRoot, payloadPath), 'tampered');
  await assert.rejects(installKit({ ...options, confirmed: true }, trust), /file hash/);
  await writeFile(join(options.kitRoot, payloadPath), payload);
  await writeFile(join(options.kitRoot, 'payloads/catalog.json'), '{"tampered":true}');
  await resignManifest();
  await assert.rejects(verifyKit(options.kitRoot, trust), /catalog signature/);
  await unchanged();
  await assert.rejects(readdir(join(options.compatibility.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
}));

test('signed inventory rejects extra files, extra empty directories and symbolic links', async () => fixture(async ({ root, options, trust }) => {
  const extra = join(options.kitRoot, 'unexpected.txt');
  await writeFile(extra, 'extra');
  await assert.rejects(verifyKit(options.kitRoot, trust), /inventory|entries/);
  await rm(extra);
  const directory = join(options.kitRoot, 'unexpected-directory');
  await mkdir(directory);
  await assert.rejects(verifyKit(options.kitRoot, trust), /unexpected directory|entries/);
  await rm(directory, { recursive: true });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyKit(options.kitRoot, trust), /symbolic link|entries/);
}));

test('manifest limits and portable path aliases reject before reading redirected paths', async () => fixture(async ({ options, trust, resignManifest }) => {
  for (const mutate of [
    value => { value.files.push({ ...value.files[0], path: '../outside' }); },
    value => { value.files.push({ ...value.files[0], path: 'UPDATE-KIT.mjs' }); },
    value => { value.files.push({ ...value.files[0], path: 'CON.txt' }); },
    value => { value.files[0].size = 64 * 1024 * 1024 + 1; },
    value => { value.files = Array.from({ length: 129 }, () => value.files[0]); },
  ]) {
    await resignManifest(mutate);
    await assert.rejects(verifyKit(options.kitRoot, trust));
  }
  await writeFile(join(options.kitRoot, 'kit-manifest.json'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(verifyKit(options.kitRoot, trust), /oversized/);
}));

test('the kit refuses a signed component requiring a different runtime even when its id and version match', async () => fixture(async ({ options, trust, catalog, signCatalog, resignManifest }) => {
  catalog.components[0].requiresDshVersion = '9.0.0';
  await signCatalog(); await resignManifest();
  await assert.rejects(verifyKit(options.kitRoot, trust), /no supported first-install updater/);
}));

test('confirmation binds both payload and profile revision and refuses a concurrent profile edit without backups', async () => fixture(async ({ options, trust, patch, unchanged }) => {
  const plan = await inspectKit(options, trust);
  for (const extra of [{}, { expectedSha256: '0'.repeat(64), expectedPatchRevision: plan.patchRevision },
    { expectedSha256: plan.component.sha256, expectedPatchRevision: 'sha256-stale' }]) {
    await assert.rejects(installKit({ ...options, confirmed: true, ...extra }, trust), /confirmed kit plan differs/);
    await unchanged();
  }
  const edit = '# newer user revision\n[]\n';
  await writeFile(patch, edit);
  await assert.rejects(installKit({ ...options, confirmed: true, expectedSha256: plan.component.sha256, expectedPatchRevision: plan.patchRevision }, trust), /confirmed kit plan differs/);
  assert.equal(await readFile(patch, 'utf8'), edit);
  await assert.rejects(readdir(join(options.compatibility.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
}));

test('confirmed first mount creates verifiable private backups and leaves settings, sessions and package configuration intact', async () => fixture(async ({ options, trust, patch, profile, profileBytes, confirm }) => {
  const packageBytes = await readFile(join(profile, 'package.json'));
  const result = await confirm();
  assert.equal(result.status, 'activation-pending');
  assert.equal(result.rowId, 'clawmaster-update-component-updates');
  assert.equal((await import(result.entryUrl)).name, 'clawmaster-updates');
  const backup = JSON.parse(await readFile(join(result.backupDirectory, 'receipt.json'), 'utf8'));
  assert.equal(backup.patchRevision, `sha256-${hash(Buffer.from(profileBytes))}`);
  assert.deepEqual(backup.files.map(file => file.path), ['profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'cordis.patch.yml']);
  for (const file of backup.files) if (file.existed) {
    const bytes = await readFile(join(result.backupDirectory, file.storedAs));
    assert.equal(hash(bytes), file.sha256);
  }
  assert.equal(await readFile(join(result.backupDirectory, '0.original'), 'utf8'), profileBytes);
  assert.deepEqual(await readFile(join(profile, 'package.json')), packageBytes);
  assert.ok((await readFile(patch, 'utf8')).startsWith('# user profile comment\n'));
  assert.equal(await readFile(join(options.compatibility.dshHome, 'settings.yaml'), 'utf8'), 'model: keep-existing-model\n');
  assert.equal(await readFile(join(options.compatibility.dshHome, 'sessions', 'fixture.jsonl'), 'utf8'), '{"session":"keep-existing-data"}\n');
  assert.deepEqual(await readdir(join(options.compatibility.dshHome, 'clawmaster-updates', 'kit-install-stages')), []);
  assert.equal((await inspectKit(options, trust)).status, 'updater-already-present');
}));

test('backup and install staging links cannot redirect writes outside the selected home', async () => fixture(async ({ root, options, confirm, unchanged }) => {
  const managed = join(options.compatibility.dshHome, 'clawmaster-updates');
  await mkdir(managed);
  for (const name of ['kit-backups', 'kit-install-stages']) {
    const outside = join(root, `outside-${name}`);
    await mkdir(outside);
    const link = join(managed, name);
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(confirm(), /redirected|directory/);
    assert.deepEqual(await readdir(outside), []);
    await unchanged();
    await unlink(link);
  }
}));

test('already declared and higher installed updaters never get overwritten by an older kit', async () => fixture(async ({ root, options, trust, component, patch, profileBytes, unchanged }) => {
  await writeFile(patch, '- insert:\n    - id: clawmaster-update-component-updates\n      name: unrelated-user-plugin\n      disabled: true\n');
  await assert.rejects(installKit({ ...options, confirmed: true }, trust), /does not support first updater bootstrap/);
  await assert.rejects(readdir(join(options.compatibility.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
  await writeFile(patch, profileBytes);
  const archivePath = join(root, 'newer.tgz');
  await writeFile(archivePath, archive('0.2.0'));
  await installComponent({ archivePath, descriptor: { ...component, version: '0.2.0' }, dshHome: options.compatibility.dshHome, dshVersion: '0.1.5-rc.2', providedPackages: { '@deepseek-ai/cordis': '4.0.2' } });
  assert.equal((await inspectKit(options, trust)).status, 'updater-already-present');
  await assert.rejects(installKit({ ...options, confirmed: true }, trust), /does not support first updater bootstrap/);
  await unchanged();
}));

test('unknown CLI locations and a signed archive with the wrong package identity retain the kit without changing the profile', async () => fixture(async ({ root, options, trust, component, payloadPath, signCatalog, resignManifest, confirm, unchanged }) => {
  const unknown = await inspectKit({ ...options, compatibility: { ...options.compatibility, runtimeRoot: join(root, 'missing-runtime') } }, trust);
  assert.equal(unknown.status, 'needs-location');
  assert.ok((await readFile(join(options.kitRoot, payloadPath))).length > 0);
  const bytes = archive('0.1.0', 'wrong-package');
  component.sha256 = hash(bytes); component.size = bytes.length;
  await writeFile(join(options.kitRoot, payloadPath), bytes); await signCatalog(); await resignManifest();
  await assert.rejects(confirm(), /package identity/);
  assert.deepEqual(await readdir(join(options.compatibility.dshHome, 'clawmaster-updates', 'kit-install-stages')), []);
  await unchanged();
}));

test('an authenticated offline kit applies a staged updater after the Host has exited', async t => fixture(async ({ options, trust, component, payloadPath, patch }) => {
  const dshHome = options.compatibility.dshHome;
  await installComponent({ archivePath: join(options.kitRoot, payloadPath), descriptor: component, dshHome,
    dshVersion: '0.1.5-rc.2', providedPackages: { '@deepseek-ai/cordis': '4.0.2' } });
  const staged = await activateComponent({ dshHome, id: 'updates', version: component.version, confirmed: true,
    expectedPatchRevision: await readComponentPatchRevision(dshHome) });
  await mkdir(join(dshHome, 'desktop'));
  await writeFile(join(dshHome, 'desktop/current-runtime.json'), JSON.stringify({ schemaVersion: 1, hostPid: 2147483647, runId: 'exited-host', status: 'ready' }));

  const result = await repairKit({ kitRoot: options.kitRoot, dshHome }, trust);
  assert.equal(result.status, 'offline-maintenance-complete');
  assert.deepEqual(result.operations.map(operation => ({ token: operation.token, state: operation.state })), [{ token: staged.rollbackToken, state: 'selected-unverified' }]);
  assert.match(await readFile(patch, 'utf8'), /clawmaster-update-component-updates/);
}));

test('kit 0.1.0 repairs staged operations from updater 0.1.0 and 0.1.1 through health and rollback', async t => {
  for (const oldVersion of ['0.1.0', '0.1.1']) {
    await fixture(async ({ options, trust, component, payloadPath, patch, confirm }) => {
      const dshHome = options.compatibility.dshHome;
      let previousEntryUrl;
      if (oldVersion === '0.1.0') {
        previousEntryUrl = (await confirm()).entryUrl;
      } else {
        const previousArchive = join(options.compatibility.dshHome, `old-${oldVersion}.tgz`);
        await writeFile(previousArchive, archive(oldVersion));
        await installComponent({ archivePath: previousArchive, descriptor: { ...component, version: oldVersion }, dshHome,
          dshVersion: '0.1.5-rc.2', providedPackages: { '@deepseek-ai/cordis': '4.0.2' } });
        previousEntryUrl = (await mountFirstUpdaterComponent({ dshHome, version: oldVersion, confirmed: true,
          expectedPatchRevision: await readComponentPatchRevision(dshHome) })).entryUrl;
      }
      const before = await readFile(patch, 'utf8');
      const nextVersion = '0.1.2';
      const nextArchive = join(options.compatibility.dshHome, `next-${nextVersion}.tgz`);
      await writeFile(nextArchive, archive(nextVersion));
      const next = await installComponent({ archivePath: nextArchive, descriptor: { ...component, version: nextVersion }, dshHome,
        dshVersion: '0.1.5-rc.2', providedPackages: { '@deepseek-ai/cordis': '4.0.2' } });
      const staged = await activateComponent({ dshHome, id: 'updates', version: nextVersion, confirmed: true,
        expectedPatchRevision: await readComponentPatchRevision(dshHome) });
      const journal = join(dshHome, 'clawmaster-updates', 'operations', `${staged.rollbackToken}.json`);
      const record = JSON.parse(await readFile(journal, 'utf8'));
      // Updater 0.1.0 and 0.1.1 persisted this finite field set for restart-only operations.
      await writeFile(journal, JSON.stringify({ before: record.before, after: record.after, afterRevision: record.afterRevision,
        id: record.id, version: record.version, activation: record.activation, state: record.state }));
      assert.equal(await readFile(patch, 'utf8'), before);

      await mkdir(join(dshHome, 'desktop'));
      const runtimeState = join(dshHome, 'desktop', 'current-runtime.json');
      await writeFile(runtimeState, JSON.stringify({ schemaVersion: 1, hostPid: 2147483647, runId: `legacy-${oldVersion}`, status: 'ready' }));
      const repaired = await repairKit({ kitRoot: options.kitRoot, dshHome }, trust);
      assert.deepEqual(repaired.operations.map(row => ({ token: row.token, state: row.state })),
        [{ token: staged.rollbackToken, state: 'awaiting-health' }]);
      assert.ok((await readFile(patch, 'utf8')).includes(next.entryUrl));
      assert.equal((await import(next.entryUrl)).version, nextVersion);

      const oldRunId = process.env.CLAWMASTER_RUNTIME_RUN_ID;
      process.env.CLAWMASTER_RUNTIME_RUN_ID = `loaded-${oldVersion}`;
      try {
        assert.deepEqual(await confirmComponentHealth({ dshHome, entryUrl: next.entryUrl, hostPid: process.pid, runId: `loaded-${oldVersion}` }), [staged.rollbackToken]);
      } finally {
        if (oldRunId === undefined) delete process.env.CLAWMASTER_RUNTIME_RUN_ID;
        else process.env.CLAWMASTER_RUNTIME_RUN_ID = oldRunId;
      }
      const rollback = await rollbackComponent({ dshHome, rollbackToken: staged.rollbackToken,
        expectedPatchRevision: await readComponentPatchRevision(dshHome), confirmed: true });
      assert.equal(rollback.status, 'restart-required');
      await writeFile(runtimeState, JSON.stringify({ schemaVersion: 1, hostPid: 2147483647, runId: `rollback-${oldVersion}`, status: 'ready' }));
      assert.equal((await maintainRestartComponents(dshHome))[0].state, 'selected-unverified');
      assert.ok((await readFile(patch, 'utf8')).includes(previousEntryUrl));
      assert.equal((await import(previousEntryUrl)).version, oldVersion);
      assert.ok((await readFile(patch, 'utf8')).includes(`/${oldVersion}/`));
      assert.equal((await listComponentOperations(dshHome)).find(row => row.token === staged.rollbackToken).state, 'selected-unverified');
    });
  }
});

function nativeFixture(trust, payload = 'test') {
  const suffixes = { 'windows-x86_64': 'windows-x64-setup.exe', 'darwin-x86_64': 'macos-x64.app.tar.gz', 'darwin-aarch64': 'macos-arm64.app.tar.gz', 'linux-x86_64': 'linux-x64.AppImage', 'linux-x86_64-deb': 'linux-x64.deb' };
  const release = { version: '0.2.1', notes: '', pub_date: '2026-09-15T00:00:00Z', platforms: Object.fromEntries(Object.entries(suffixes).map(([target, suffix]) => [target,
    { url: `https://fixture.invalid/updates/clawmaster/versions/0.2.1/clawmaster-0.2.1-${suffix}`, signature: encode(nativeSignature) }])) };
  const requests = [];
  return { requests, release, trust: { ...trust, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); requests.push(url);
    if (url === trust.nativeManifestUrl) return new Response(JSON.stringify(release));
    assert.ok(Object.values(release.platforms).some(item => item.url === url));
    return new Response(payload);
  } } };
}

test('native planning is metadata-only and target or confirmation mismatches do not download payloads', async () => fixture(async ({ options, trust, unchanged }) => {
  const server = nativeFixture(trust);
  const request = { ...options, platform: 'win32', arch: 'x64' };
  const plan = await nativeKit(request, server.trust);
  assert.equal(plan.status, 'native-download-confirmation-required');
  assert.equal(plan.target, 'windows-x86_64');
  for (const change of [{ expectedVersion: '0.2.0', expectedDigest: plan.digest }, { expectedVersion: plan.version, expectedDigest: 'tampered' }]) {
    await assert.rejects(nativeKit({ ...request, confirmed: true, ...change }, server.trust), /confirmed native plan differs/);
  }
  await assert.rejects(nativeKit({ ...request, target: 'darwin-aarch64' }, server.trust), /supported on this machine/);
  await assert.rejects(nativeKit({ ...request, platform: 'linux' }, server.trust), /Linux requires an explicit/);
  assert.ok(server.requests.every(url => url === trust.nativeManifestUrl));
  await assert.rejects(readdir(join(options.compatibility.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
  await unchanged();
}));

test('confirmed native download verifies both the cached payload and named copy without executing an installer', async () => fixture(async ({ options, trust, unchanged }) => {
  const server = nativeFixture(trust);
  const request = { ...options, platform: 'win32', arch: 'x64' };
  const plan = await nativeKit(request, server.trust);
  const result = await nativeKit({ ...request, confirmed: true, expectedVersion: plan.version, expectedDigest: plan.digest }, server.trust);
  assert.equal(result.status, 'requires-native-installer');
  assert.ok(result.path.endsWith('clawmaster-0.2.1-windows-x64-setup.exe'));
  assert.ok(result.path.includes('verified-'));
  assert.equal(await readFile(result.path, 'utf8'), 'test');
  assert.equal(result.sha256, hash(Buffer.from('test')));
  await unchanged();
}));

test('four-target kit metadata permits ARM planning but refuses Intel before confirmation or filesystem writes', async () => fixture(async ({ options, trust, unchanged }) => {
  const server = nativeFixture(trust);
  delete server.release.platforms['darwin-x86_64'];
  const plan = await nativeKit({ ...options, platform: 'darwin', arch: 'arm64' }, server.trust);
  assert.equal(plan.target, 'darwin-aarch64');
  for (const confirmed of [false, true]) {
    await assert.rejects(nativeKit({ ...options, platform: 'darwin', arch: 'x64', confirmed }, server.trust), /No native installer for darwin-x86_64/);
  }
  assert.ok(server.requests.every(url => url === trust.nativeManifestUrl));
  await assert.rejects(readdir(join(options.compatibility.dshHome, 'clawmaster-updates')), { code: 'ENOENT' });
  await unchanged();
}));

test('bad native bytes are not published and a failed second verification removes its unverified named-copy directory', async () => fixture(async ({ options, trust, unchanged }) => {
  const request = { ...options, platform: 'win32', arch: 'x64' };
  const invalid = nativeFixture(trust, 'tampered');
  const invalidPlan = await nativeKit(request, invalid.trust);
  await assert.rejects(nativeKit({ ...request, confirmed: true, expectedVersion: invalidPlan.version, expectedDigest: invalidPlan.digest }, invalid.trust), /signature verification/);
  const managed = join(options.compatibility.dshHome, 'clawmaster-updates');
  assert.deepEqual(await readdir(join(managed, 'downloads')), []);
  const server = nativeFixture(trust);
  let keyReads = 0;
  Object.defineProperty(server.trust, 'nativePublicKey', { get: () => ++keyReads === 1 ? trust.nativePublicKey : encode(nativeKey.replace('73Y7', '73Y8')) });
  const plan = await nativeKit(request, server.trust);
  await assert.rejects(nativeKit({ ...request, confirmed: true, expectedVersion: plan.version, expectedDigest: plan.digest }, server.trust), /signature verification/);
  assert.equal(keyReads, 2);
  assert.deepEqual(await readdir(join(managed, 'native-downloads')), []);
  await unchanged();
}));
