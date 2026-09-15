import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { Header } from 'tar';
import { inspectCompatibility } from '../src/compatibility.ts';
import { installComponent } from '../src/components.ts';

const DSH = '0.1.5-rc.2';
const CORDIS = '4.0.2';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-kit-compatibility-'));
  try {
    const runtimeRoot = join(root, 'runtime');
    const cliRoot = join(runtimeRoot, 'apps', 'cli');
    await mkdir(join(cliRoot, 'lib'), { recursive: true });
    await mkdir(join(runtimeRoot, 'vendor', 'cordis'), { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: DSH }));
    await writeFile(join(runtimeRoot, 'vendor', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: CORDIS }));
    await writeFile(join(cliRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH }));
    const cli = join(cliRoot, 'lib', 'bin.js');
    await writeFile(cli, 'throw new Error("The compatibility inspector must never execute the CLI");\n');
    const node = join(root, 'node');
    await writeFile(node, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const dshHome = join(root, 'home');
    const profile = join(dshHome, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    const manifest = { private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(profile, 'cordis.patch.yml'), '# user comment\n[]\n');
    await mkdir(join(dshHome, 'settings.yaml'));
    await writeFile(join(dshHome, '.env'), 'SECRET_DO_NOT_READ=fixture-not-a-credential\n');
    await mkdir(join(dshHome, 'credentials.json'));
    const launchManifestPath = join(root, 'DeepSeek Harness', 'bin', 'dsh-launch.json');
    await mkdir(join(launchManifestPath, '..'), { recursive: true });
    const launch = { node, cli, dshHome, pathPrepend: [root] };
    await writeFile(launchManifestPath, JSON.stringify(launch));
    const statePath = join(dshHome, 'desktop', 'current-runtime.json');
    const state = { schemaVersion: 1, status: 'ready', hostPid: 123, runId: 'fixture-run', harnessRoot: runtimeRoot, harnessVersion: DSH };
    const stateFile = async (change = {}) => { await mkdir(join(dshHome, 'desktop'), { recursive: true }); await writeFile(statePath, JSON.stringify({ ...state, ...change })); };
    await run({ root, runtimeRoot, dshHome, profile, manifest, cli, node, launchManifestPath, launch, statePath, stateFile,
      options: { runtimeRoot, dshHome, platform: process.platform } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('current runtime and default web profile support only static first bootstrap without touching user files', async () => fixture(async ({ options, dshHome, profile }) => {
  const before = await readdir(dshHome);
  const result = await inspectCompatibility(options);
  assert.equal(result.status, 'supported-component-bootstrap');
  assert.equal(result.knownDshVersion, DSH);
  assert.equal(result.knownCordisVersion, CORDIS);
  assert.equal(result.updaterDeclared, false);
  assert.equal(result.source, 'explicit-runtime');
  assert.deepEqual(await readdir(dshHome), before);
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '# user comment\n[]\n');
  assert.ok(!JSON.stringify(result).includes('SECRET_DO_NOT_READ'));
}));

test('missing or unrelated locations never imply component compatibility or create a new home', async () => fixture(async ({ root, options }) => {
  const business = join(root, 'business');
  await mkdir(business);
  await writeFile(join(business, 'package.json'), '{"name":"business-workspace"}');
  const unknown = await inspectCompatibility({ cwd: business, platform: process.platform });
  assert.equal(unknown.status, 'needs-location');
  assert.equal(unknown.knownDshVersion, null);
  const missing = join(root, 'missing-home');
  const result = await inspectCompatibility({ ...options, dshHome: missing });
  assert.equal(result.status, 'needs-location');
  assert.equal(result.knownDshVersion, DSH);
  await assert.rejects(readdir(missing), { code: 'ENOENT' });
  assert.equal((await inspectCompatibility({ ...options, runtimeRoot: './relative' })).status, 'needs-location');
}));

test('observed incompatible DSH and Cordis versions require native upgrade instead of plugin replacement', async () => fixture(async ({ options, runtimeRoot }) => {
  for (const [path, name, version] of [[join(runtimeRoot, 'package.json'), '@deepseek-ai/dsh-root', '0.1.4'],
    [join(runtimeRoot, 'vendor', 'cordis', 'package.json'), '@deepseek-ai/cordis', '3.0.0']]) {
    const original = await readFile(path);
    await writeFile(path, JSON.stringify({ name, version }));
    const result = await inspectCompatibility(options);
    assert.equal(result.status, 'native-upgrade-required');
    assert.ok(result.knownDshVersion);
    await writeFile(path, original);
  }
}));

test('a bounded CLI entry ancestor identifies the runtime while a mismatched CLI package is rejected', async () => fixture(async ({ options, cli, runtimeRoot }) => {
  const input = { dshHome: options.dshHome, platform: process.platform, hostIdentity: { pid: 123, runId: undefined, entry: cli } };
  assert.equal((await inspectCompatibility(input)).source, 'host-entry');
  await writeFile(join(runtimeRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.1' }));
  assert.equal((await inspectCompatibility(input)).status, 'needs-location');
}));

test('matching live Host records locate manifests and stale records never select a runtime', async () => fixture(async ({ dshHome, cli, stateFile, statePath }) => {
  const options = { dshHome, platform: process.platform, runtimeStatePath: statePath,
    hostIdentity: { pid: 123, runId: 'fixture-run', entry: undefined } };
  await stateFile();
  assert.equal((await inspectCompatibility(options)).source, 'desktop-runtime-locator');
  for (const change of [{ hostPid: 999 }, { runId: 'stale' }, { status: 'stopped' }, { harnessVersion: '0.0.1' }]) {
    await stateFile(change);
    const result = await inspectCompatibility(options);
    assert.equal(result.status, 'needs-location');
    assert.equal(result.runtimeRoot, null);
  }
  await stateFile();
  const fallback = await inspectCompatibility({ ...options, hostIdentity: { ...options.hostIdentity, runId: undefined, entry: cli } });
  assert.equal(fallback.source, 'host-entry');
}));

test('an AI utility can use an inherited run marker only with live Host evidence and real matching manifests', async () => fixture(async ({ dshHome, stateFile, statePath }) => {
  await stateFile();
  const options = { dshHome, platform: process.platform, runtimeStatePath: statePath, inheritedRunId: 'fixture-run' };
  const pids = [];
  const live = await inspectCompatibility(options, { isProcessAlive: pid => { pids.push(pid); return true; } });
  assert.equal(live.status, 'supported-component-bootstrap');
  assert.equal(live.source, 'desktop-runtime-locator');
  assert.deepEqual(pids, [123]);
  assert.equal((await inspectCompatibility(options, { isProcessAlive: () => false })).status, 'needs-location');
  await stateFile({ runId: 'previous-run' });
  assert.equal((await inspectCompatibility(options, { isProcessAlive: () => assert.fail('mismatched markers must not probe arbitrary pids') })).status, 'needs-location');
}));

test('the default signal-zero probe accepts this live test process without executing an external command', async () => fixture(async ({ dshHome, stateFile }) => {
  await stateFile({ hostPid: process.pid });
  const result = await inspectCompatibility({ dshHome, inheritedRunId: 'fixture-run', platform: process.platform });
  assert.equal(result.source, 'desktop-runtime-locator');
}));

test('early beta launch metadata locates the same home and checks the actual CLI, runtime and executable Node file', async () => fixture(async ({ launchManifestPath, options, node }) => {
  const result = await inspectCompatibility({ launchManifestPath, platform: process.platform });
  assert.equal(result.status, 'supported-component-bootstrap');
  assert.equal(result.source, 'launch-manifest-locator');
  assert.equal(result.runtimeRoot, options.runtimeRoot);
  assert.equal(result.dshHome, options.dshHome);
  assert.equal(result.verifiedNodePath, node);
  if (process.platform !== 'win32') {
    await chmod(node, 0o600);
    assert.equal((await inspectCompatibility({ launchManifestPath, platform: process.platform })).verifiedNodePath, null);
  }
}));

test('launch metadata cannot replace an explicit home or use a CLI whose manifest disagrees with its runtime', async () => fixture(async ({ launchManifestPath, launch, root, runtimeRoot }) => {
  const selected = join(root, 'different-home');
  const mismatch = await inspectCompatibility({ launchManifestPath, dshHome: selected, platform: process.platform });
  assert.equal(mismatch.status, 'needs-location');
  assert.equal(mismatch.dshHome, selected);
  assert.ok(mismatch.reasons.some(reason => reason.code === 'launch-home-mismatch'));
  await writeFile(join(runtimeRoot, 'apps', 'cli', 'package.json'), '{"name":"unrelated-cli","version":"0.1.5-rc.2"}');
  assert.equal((await inspectCompatibility({ launchManifestPath, platform: process.platform })).status, 'needs-location');
  assert.equal(await readFile(launchManifestPath, 'utf8'), JSON.stringify(launch));
}));

test('disabled updater rows and declared packages prevent first installation without claiming they are active', async () => fixture(async ({ options, profile, manifest }) => {
  for (const patch of ['- insert:\n    - id: clawmaster-update-component-updates\n      name: unrelated-plugin\n      disabled: true\n',
    '- insert:\n    - id: custom-id\n      name: "@clawmaster/dsh-updates"\n']) {
    await writeFile(join(profile, 'cordis.patch.yml'), patch);
    const result = await inspectCompatibility(options);
    assert.equal(result.status, 'updater-already-present');
    assert.equal(result.updaterDeclared, true);
    assert.equal(result.updaterVersion, null);
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patch);
  }
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ ...manifest, dependencies: { '@clawmaster/dsh-updates': '0.1.0' } }));
  assert.equal((await inspectCompatibility(options)).status, 'updater-already-present');
}));

test('startup-only and custom service profiles require inspection instead of promising hot activation', async () => fixture(async ({ options, profile, manifest }) => {
  await writeFile(join(profile, 'package.json'), JSON.stringify({ ...manifest, dsh: { profile: { ...manifest.dsh.profile, patchReload: 'startup' } } }));
  assert.equal((await inspectCompatibility(options)).reasons.at(-1).code, 'profile-not-live');
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
  for (const patch of ['- id: approval\n  disabled: true\n', '- id: tools\n  disabled: !!js process.env.TOOLS_DISABLED\n', '- id: commands\n  name: another-provider\n']) {
    await writeFile(join(profile, 'cordis.patch.yml'), patch);
    assert.equal((await inspectCompatibility(options)).reasons.at(-1).code, 'required-services-customized');
  }
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: user-plugin\n  config:\n    approval:\n      disabled: true\n    password: SECRET_NOT_RETURNED\n');
  const result = await inspectCompatibility(options);
  assert.equal(result.status, 'supported-component-bootstrap');
  assert.ok(!JSON.stringify(result).includes('SECRET_NOT_RETURNED'));
}));

test('unusable metadata fails closed without returning parser excerpts or following links', async () => fixture(async ({ options, profile, root, statePath, stateFile }) => {
  const patch = join(profile, 'cordis.patch.yml');
  await writeFile(patch, 'password: [SECRET_PARSE_EXCERPT\n');
  const malformed = await inspectCompatibility(options);
  assert.equal(malformed.status, 'needs-location');
  assert.ok(!JSON.stringify(malformed).includes('SECRET_PARSE_EXCERPT'));
  await writeFile(patch, 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await inspectCompatibility(options)).status, 'needs-location');
  await rm(patch);
  const outside = join(root, 'outside.yml');
  await writeFile(outside, '[]\n');
  await symlink(outside, patch);
  assert.equal((await inspectCompatibility(options)).status, 'needs-location');
  await stateFile();
  const mismatch = await inspectCompatibility({ dshHome: options.dshHome, platform: process.platform, runtimeStatePath: `${statePath}.other` });
  assert.ok(mismatch.reasons.some(reason => reason.code === 'runtime-state-home-mismatch'));
}));

async function installedUpdater(root, home, version) {
  const descriptor = { id: 'updates', packageName: '@clawmaster/dsh-updates', version, kind: 'component', entry: './dist/index.js', activation: 'restart', requiresDshVersion: DSH };
  const blocks = [];
  for (const [path, content] of [['package/package.json', JSON.stringify({ name: descriptor.packageName, version, type: 'module' })], ['package/dist/index.js', 'export const name="updater";\n']]) {
    const bytes = Buffer.from(content);
    const header = new Header({ path, type: 'File', size: bytes.length, mode: 0o644 });
    header.encode();
    blocks.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const archivePath = join(root, `updater-${version}.tgz`);
  await writeFile(archivePath, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
  return installComponent({ archivePath, descriptor, dshHome: home, dshVersion: DSH });
}

test('verified staged updater state distinguishes resumable bootstrap, a different version, and corrupted installed files', async () => fixture(async ({ root, options }) => {
  await installedUpdater(root, options.dshHome, '0.1.0');
  const resumable = await inspectCompatibility(options);
  assert.equal(resumable.status, 'supported-component-bootstrap');
  assert.equal(resumable.updaterVersion, '0.1.0');
  assert.equal(resumable.updaterDeclared, false);
  const newer = await installedUpdater(root, options.dshHome, '0.2.0');
  assert.equal((await inspectCompatibility(options)).status, 'updater-already-present');
  await writeFile(new URL(newer.entryUrl), 'tampered');
  assert.equal((await inspectCompatibility(options)).status, 'needs-location');
}));
