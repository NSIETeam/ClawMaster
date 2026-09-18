import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { Header, Pax } from 'tar';
import { parseDocument } from 'yaml';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';

// The same external-state cases also exercise a packaged entry when the artifact lane supplies its path.
const moduleUrl = process.env.CLAWMASTER_COMPONENT_ARTIFACT
  ? pathToFileURL(resolve(process.env.CLAWMASTER_COMPONENT_ARTIFACT)).href
  : new URL('../src/components.ts', import.meta.url).href;
const { activateComponent, highestInstalledComponentVersion, installComponent, readComponentPatchRevision, rollbackComponent } = await import(moduleUrl);

const descriptor = { id: 'fixture', packageName: '@clawmaster/fixture', version: '1.0.0', entry: './dist/index.js', kind: 'component', activation: 'hot', requiresDshVersion: '>=0.1.5-rc.2' };
const manifest = { name: descriptor.packageName, version: descriptor.version, type: 'module' };

// Maintained tar headers let the parser tests express paths and links that the fixture filesystem cannot safely create.
function archive(entries) {
  const blocks = [];
  for (const { path, content = '', type = 'File', linkpath, paxPath } of entries) {
    const bytes = Buffer.from(content);
    const header = new Header({ path, type, size: type === 'File' ? bytes.length : 0, mode: 0o644, ...(linkpath === undefined ? {} : { linkpath }) });
    header.encode();
    assert.equal(new Header(header.block).path, path);
    if (paxPath !== undefined) blocks.push(new Pax({ path: paxPath }).encode());
    blocks.push(header.block);
    if (type === 'File') blocks.push(bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function entries(packageManifest = manifest, extra = []) {
  return [
    { path: 'package/package.json', content: JSON.stringify(packageManifest) },
    { path: 'package/dist/index.js', content: 'export const name = "fixture"; export function apply() {}\n' },
    ...extra,
  ];
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-components-'));
  try {
    const dshHome = join(root, 'home');
    await mkdir(dshHome);
    const archivePath = join(root, 'component.tgz');
    await writeFile(archivePath, archive(entries()));
    const options = { archivePath, descriptor, dshHome, dshVersion: '0.1.5-rc.2', providedPackages: { '@deepseek-ai/cordis': '4.0.2' } };
    const patch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const initializePatch = async text => {
      await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true });
      await writeFile(patch, text);
    };
    const activate = async (overrides = {}) => activateComponent({ dshHome, id: descriptor.id, version: descriptor.version,
      expectedPatchRevision: await readComponentPatchRevision(dshHome), confirmed: true, ...overrides });
    await run({ root, options, patch, initializePatch, activate });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('installation preserves verified bytes, never runs package scripts, and does not activate', async () => fixture(async ({ root, options, patch }) => {
  await writeFile(options.archivePath, archive(entries({ ...manifest, scripts: { postinstall: `touch ${join(root, 'executed')}` } })));
  const result = await installComponent(options);
  assert.equal(result.status, 'installed');
  assert.equal(await readFile(fileURLToPath(result.entryUrl), 'utf8'), entries()[1].content);
  await assert.rejects(readFile(patch), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'executed')), { code: 'ENOENT' });
  assert.deepEqual(await installComponent(options), result);
  await writeFile(fileURLToPath(result.entryUrl), 'tampered');
  await assert.rejects(installComponent(options), /digest differs/);
}));

test('an immutable version cannot be replaced by a different authenticated archive', async () => fixture(async ({ options }) => {
  const result = await installComponent(options);
  const original = await readFile(fileURLToPath(result.entryUrl), 'utf8');
  await writeFile(options.archivePath, archive(entries(manifest, [{ path: 'package/extra.txt', content: 'different release' }])));
  await assert.rejects(installComponent(options), /different content/);
  assert.equal(await readFile(fileURLToPath(result.entryUrl), 'utf8'), original);
}));

test('highest installed version is a read-only verified observation that includes staged components', async () => fixture(async ({ root, options }) => {
  const missingHome = join(root, 'missing-home');
  assert.equal(await highestInstalledComponentVersion(missingHome, 'fixture'), null);
  await assert.rejects(readdir(missingHome), { code: 'ENOENT' });
  assert.equal(await highestInstalledComponentVersion(options.dshHome, 'fixture'), null);
  assert.deepEqual(await readdir(options.dshHome), []);
  await installComponent(options);
  const version = '1.10.0';
  await writeFile(options.archivePath, archive(entries({ ...manifest, version })));
  const latest = await installComponent({ ...options, descriptor: { ...descriptor, version } });
  assert.equal(await highestInstalledComponentVersion(options.dshHome, 'fixture'), version);
  assert.equal(await highestInstalledComponentVersion(options.dshHome, 'other'), null);
  await writeFile(fileURLToPath(latest.entryUrl), 'tampered');
  await assert.rejects(highestInstalledComponentVersion(options.dshHome, 'fixture'), /digest differs/);
}));

test('another process cannot activate an older candidate after a higher installation commits while its profile lock is held', { timeout: 20_000 }, async () => fixture(async ({ options, patch, activate }) => {
  await installComponent(options);
  await activate();
  const original = await readFile(patch, 'utf8');
  const expectedPatchRevision = await readComponentPatchRevision(options.dshHome);
  const started = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let child;
  let output = '';
  let response;
  let exit;
  try {
    await withFileLock(patch, async () => {
      child = fork(new URL('./fixtures/component-operation.mjs', import.meta.url), [], {
        execArgv: process.env.CLAWMASTER_COMPONENT_ARTIFACT ? [] : ['--import', import.meta.resolve('tsx/esm')],
        env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      deadline.unref();
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = `${output}${bytes}`.slice(-10_000); });
      child.on('message', message => {
        if (message.status === 'starting') started.resolve();
        else response = message;
      });
      child.once('error', error => { started.reject(error); completed.resolve({ status: 'subprocess-failed', message: error.message }); });
      exit = new Promise(resolveExit => child.once('close', (code, signal) => {
        clearTimeout(deadline);
        const error = new Error(`Component subprocess exited ${code}/${signal}: ${output}`);
        if (!response || code !== 0) { started.reject(error); completed.resolve({ status: 'subprocess-failed', message: error.message }); }
        else completed.resolve(response);
        resolveExit();
      }));
      child.send({ moduleUrl, options: { dshHome: options.dshHome, id: descriptor.id, version: descriptor.version, expectedPatchRevision, confirmed: true } });
      await started.promise;
      const version = '1.1.0';
      await writeFile(options.archivePath, archive(entries({ ...manifest, version })));
      await installComponent({ ...options, descriptor: { ...descriptor, version } });
    });
    const result = await completed.promise;
    assert.equal(result.status, 'rejected', result.message);
    assert.match(result.message, /downgrade/);
    assert.equal(await readFile(patch, 'utf8'), original);
    await writeFile(options.archivePath, archive(entries()));
    await assert.rejects(installComponent(options), /downgrade/);
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL');
    await exit;
  }
}));

test('unexpected files in an installed component prevent activation', async () => fixture(async ({ options, activate }) => {
  const result = await installComponent(options);
  await writeFile(join(result.directory, 'package', 'unverified.js'), 'export const injected = true;');
  await assert.rejects(activate(), /unverified file/);
}));

test('descriptor identity and Host versions are checked before installation', async () => fixture(async ({ options }) => {
  for (const change of [{ id: '../other' }, { version: '../1.0.0' }, { entry: '../outside.js' }, { entry: '/outside.js' }, { entry: './dist\\index.js' }, { requiresDshVersion: '>=9.0.0' }, { id: 'updates' }]) {
    await assert.rejects(installComponent({ ...options, descriptor: { ...descriptor, ...change } }), /Invalid|unsafe|different DSH|restart/);
  }
  await assert.rejects(installComponent({ ...options, dshVersion: 'unknown' }), /different DSH/);
  await writeFile(options.archivePath, archive(entries({ ...manifest, name: 'somebody-else' })));
  await assert.rejects(installComponent(options), /package identity/);
}));

test('traversal, links, device nodes, duplicate names and Windows path aliases are rejected without public extraction', async () => fixture(async ({ root, options }) => {
  for (const extra of [
    { path: '../escape', content: 'bad' }, { path: '/absolute', content: 'bad' }, { path: 'package/../escape', content: 'bad' },
    { path: 'package/dist/link', type: 'SymbolicLink', linkpath: '../../../escape' },
    { path: 'package/dist/hard', type: 'Link', linkpath: 'package/dist/index.js' },
    { path: 'package/device', type: 'CharacterDevice' }, { path: 'package/dist/index.js', content: 'duplicate' },
    { path: 'package/DIST/INDEX.JS', content: 'case alias' }, { path: 'package/CON.txt', content: 'device alias' },
    { path: 'package/a\\b', content: 'separator alias' },
    { path: 'package/safe-path', paxPath: 'package/a\\b', content: 'extended separator alias' },
    { path: 'package/safe-path', paxPath: '../escape', content: 'extended traversal' },
  ]) {
    await writeFile(options.archivePath, archive(entries(manifest, [extra])));
    await assert.rejects(installComponent(options), /unsafe|only regular|duplicate|case-conflicting/, extra.paxPath ?? extra.path);
    const owner = join(options.dshHome, 'clawmaster-updates', 'components', 'fixture');
    assert.deepEqual(await readdir(owner), []);
    await assert.rejects(readFile(join(root, 'escape')), { code: 'ENOENT' });
  }
}));

test('archive byte, expanded byte and entry limits reject oversized inputs', async () => fixture(async ({ options }) => {
  await assert.rejects(installComponent({ ...options, limits: { archiveBytes: 1 } }), /bounded regular/);
  await assert.rejects(installComponent({ ...options, limits: { expandedBytes: 1 } }), /extraction limits/);
  await assert.rejects(installComponent({ ...options, limits: { entries: 1 } }), /extraction limits/);
  await assert.rejects(installComponent({ ...options, limits: { entries: 0 } }), /positive integers/);
}));

test('dependency closure accepts bundled files and Host peers while rejecting network-only or incompatible packages', async () => fixture(async ({ options }) => {
  const supplied = { ...manifest, dependencies: { 'bundled-library': '^1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' } };
  await writeFile(options.archivePath, archive(entries(supplied)));
  await assert.rejects(installComponent(options), /not self-contained/);
  await writeFile(options.archivePath, archive(entries(supplied, [{ path: 'package/node_modules/bundled-library/package.json', content: JSON.stringify({ name: 'bundled-library', version: '2.0.0' }) }])));
  await assert.rejects(installComponent(options), /dependency version/);
  await writeFile(options.archivePath, archive(entries(supplied, [
    { path: 'package/node_modules/bundled-library/package.json', content: JSON.stringify({ name: 'bundled-library', version: '1.2.0' }) },
    { path: 'package/node_modules/bundled-library/library.wasm', content: 'bundled wasm bytes' },
  ])));
  await assert.rejects(installComponent({ ...options, providedPackages: {} }), /Host peer/);
  assert.equal((await installComponent(options)).status, 'installed');
}));

test('activation preserves user YAML and comments, switches only its row, and supports revision-checked rollback', async () => fixture(async ({ options, patch, initializePatch, activate }) => {
  const user = '# user-owned comment\n- id: existing-plugin\n  config:\n    mode: !!js process.env.MODE # preserve spelling\n';
  await initializePatch(user);
  const first = await installComponent(options);
  const applied = await activate();
  assert.equal(applied.status, 'activation-pending');
  const firstPatch = await readFile(patch, 'utf8');
  assert.ok(firstPatch.startsWith(user));
  assert.ok(firstPatch.includes(JSON.stringify(first.entryUrl)));
  const secondDescriptor = { ...descriptor, version: '1.1.0' };
  await writeFile(options.archivePath, archive(entries({ ...manifest, version: '1.1.0' })));
  const second = await installComponent({ ...options, descriptor: secondDescriptor });
  const updated = await activate({ version: '1.1.0' });
  assert.equal(await readFile(patch, 'utf8'), firstPatch.replace(JSON.stringify(first.entryUrl), JSON.stringify(second.entryUrl)));
  await rollbackComponent({ dshHome: options.dshHome, rollbackToken: updated.rollbackToken, expectedPatchRevision: updated.patchRevision, confirmed: true });
  assert.equal(await readFile(patch, 'utf8'), firstPatch);
  await rollbackComponent({ dshHome: options.dshHome, rollbackToken: applied.rollbackToken, expectedPatchRevision: applied.patchRevision, confirmed: true });
  assert.equal(await readFile(patch, 'utf8'), user);
}));

test('rollback re-verifies the previous component and leaves the active profile untouched when old bytes changed', async () => fixture(async ({ options, patch, activate }) => {
  const first = await installComponent(options);
  await activate();
  const previousPatch = await readFile(patch, 'utf8');
  const originalEntry = await readFile(fileURLToPath(first.entryUrl));
  const version = '1.1.0';
  await writeFile(options.archivePath, archive(entries({ ...manifest, version })));
  await installComponent({ ...options, descriptor: { ...descriptor, version } });
  const current = await activate({ version });
  const activePatch = await readFile(patch, 'utf8');
  const request = { dshHome: options.dshHome, rollbackToken: current.rollbackToken, expectedPatchRevision: current.patchRevision, confirmed: true };
  await writeFile(fileURLToPath(first.entryUrl), 'export function apply() { throw new Error("tampered"); }');
  await assert.rejects(rollbackComponent(request), /digest differs/);
  assert.equal(await readFile(patch, 'utf8'), activePatch);
  await writeFile(fileURLToPath(first.entryUrl), originalEntry);
  assert.equal((await rollbackComponent(request)).status, 'activation-pending');
  assert.equal(await readFile(patch, 'utf8'), previousPatch);
}));

test('empty and populated flow sequences and explicit document ends remain valid YAML', async () => fixture(async ({ options, patch, initializePatch, activate }) => {
  await installComponent(options);
  for (const original of ['# first profile\n[]\n', '[{id: existing, config: {enabled: true}}] # keep\n', '---\n- id: existing\n...\n']) {
    await initializePatch(original);
    await activate();
    const updated = await readFile(patch, 'utf8');
    const doc = parseDocument(updated);
    assert.deepEqual(doc.errors, []);
    assert.ok(doc.toJSON().some(item => item.insert?.[0]?.id === 'clawmaster-update-component-fixture'));
  }
}));

test('denied activation and stale approval revisions preserve the profile', async () => fixture(async ({ options, patch, initializePatch, activate }) => {
  await initializePatch('- id: user\n');
  await installComponent(options);
  const expectedPatchRevision = await readComponentPatchRevision(options.dshHome);
  await assert.rejects(activate({ confirmed: false }), /explicit confirmation/);
  await writeFile(patch, '- id: concurrent-user-edit\n');
  await assert.rejects(activate({ expectedPatchRevision }), /profile changed/);
  assert.equal(await readFile(patch, 'utf8'), '- id: concurrent-user-edit\n');
}));

test('planning a component change reads an absent profile without creating directories', async () => fixture(async ({ options }) => {
  const before = await readdir(options.dshHome);
  assert.match(await readComponentPatchRevision(options.dshHome), /^sha256-/);
  assert.deepEqual(await readdir(options.dshHome), before);
  await assert.rejects(activateComponent({ dshHome: options.dshHome, id: descriptor.id, version: descriptor.version,
    expectedPatchRevision: await readComponentPatchRevision(options.dshHome), confirmed: false }), /explicit confirmation/);
  assert.deepEqual(await readdir(options.dshHome), before);
}));

test('a filesystem root cannot be selected as component state home', async () => fixture(async ({ options }) => {
  const dshHome = parse(options.dshHome).root;
  await assert.rejects(readComponentPatchRevision(dshHome), /below the filesystem root/);
  await assert.rejects(installComponent({ ...options, dshHome }), /below the filesystem root/);
}));

test('rollback refuses later user edits and reused tokens without replacing them', async () => fixture(async ({ options, patch, initializePatch, activate }) => {
  await initializePatch('- id: user\n');
  await installComponent(options);
  const applied = await activate();
  const changed = `${await readFile(patch, 'utf8')}# user's later change\n`;
  await writeFile(patch, changed);
  await assert.rejects(rollbackComponent({ dshHome: options.dshHome, rollbackToken: applied.rollbackToken, expectedPatchRevision: applied.patchRevision, confirmed: true }), /overwrite newer edits/);
  await assert.rejects(rollbackComponent({ dshHome: options.dshHome, rollbackToken: applied.rollbackToken, expectedPatchRevision: await readComponentPatchRevision(options.dshHome), confirmed: true }), /overwrite newer edits/);
  assert.equal(await readFile(patch, 'utf8'), changed);
}));

test('colliding or user-modified rows cannot be adopted as updater-owned entries', async () => fixture(async ({ options, patch, initializePatch, activate }) => {
  await installComponent(options);
  const collision = '- insert:\n    - id: clawmaster-update-component-fixture\n      name: user-plugin\n';
  await initializePatch(collision);
  await assert.rejects(activate(), /does not belong/);
  assert.equal(await readFile(patch, 'utf8'), collision);
  await initializePatch(`${collision}${collision}`);
  await assert.rejects(activate(), /duplicated/);
}));

test('concurrent activations serialize the compare-and-write and only one matching approval succeeds', async () => fixture(async ({ options, activate }) => {
  await installComponent(options);
  const expectedPatchRevision = await readComponentPatchRevision(options.dshHome);
  const results = await Promise.allSettled([activate({ expectedPatchRevision }), activate({ expectedPatchRevision })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /profile changed/);
}));

test('self-updater staging leaves the live row unchanged and can be cancelled without a profile write', async () => fixture(async ({ options, patch, initializePatch, activate }) => {
  const original = '# unrelated existing profile\n[]\n';
  await initializePatch(original);
  const self = { ...descriptor, id: 'updates', packageName: '@clawmaster/dsh-updates', activation: 'restart' };
  await writeFile(options.archivePath, archive(entries({ ...manifest, name: self.packageName })));
  await installComponent({ ...options, descriptor: self });
  const pending = await activate({ id: self.id });
  assert.equal(pending.status, 'restart-required');
  assert.equal(await readFile(patch, 'utf8'), original);
  await rollbackComponent({ dshHome: options.dshHome, rollbackToken: pending.rollbackToken, expectedPatchRevision: pending.patchRevision, confirmed: true });
  assert.equal(await readFile(patch, 'utf8'), original);
  assert.deepEqual(await readdir(join(options.dshHome, 'clawmaster-updates', 'operations')), []);
}));
