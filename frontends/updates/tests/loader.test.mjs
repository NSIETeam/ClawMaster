import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { bootstrapUpdater } from '../src/bootstrap.ts';
import { installComponent, readComponentPatchRevision } from '../src/components.ts';

const artifact = process.env.CLAWMASTER_UPDATER_ARCHIVE;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Public legacy Minisign vector from jedisct1/rust-minisign-verify, valid for the four bytes "test".
const verificationKey = 'untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n';
const verificationSignature = 'untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n';

function profileProcess(home) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, NO_COLOR: '1' });
  const child = spawn(process.execPath, [join(repoRoot, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'web'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const events = [];
  const waiters = new Set();
  let output = '';
  let stopped = false;
  let failure;
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  timer.unref();
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000); });
  lines.on('line', line => {
    output = `${output}${line}\n`.slice(-20_000);
    if (process.env.CLAWMASTER_UPDATER_DEBUG === '1') process.stderr.write(`${line}\n`);
    if (!line.startsWith('UPDATER_FIXTURE ')) return;
    const event = JSON.parse(line.slice('UPDATER_FIXTURE '.length));
    events.push(event);
    if (event.event === 'refresh-failed' || event.event === 'command-failed') {
      failure = new Error(`Packed updater failed in the real Loader: ${event.error ?? event.message}`);
      for (const waiter of waiters) waiter.reject(failure);
      waiters.clear();
      return;
    }
    for (const waiter of [...waiters]) if (waiter.name === event.event) { waiters.delete(waiter); waiter.resolve(event); }
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      stopped = true;
      clearTimeout(timer);
      lines.close();
      for (const waiter of waiters) waiter.reject(new Error(`Profile exited before ${waiter.name}: ${code}/${signal}\n${output}`));
      waiters.clear();
      resolveExit({ code, signal });
    });
  });
  return {
    events,
    async event(name) {
      if (failure) throw failure;
      const found = events.find(item => item.event === name);
      if (found) return found;
      if (stopped) throw new Error(`Profile already exited before ${name}\n${output}`);
      return new Promise((resolveEvent, reject) => waiters.add({ name, resolve: resolveEvent, reject }));
    },
    async stop() {
      if (!stopped && child.connected) child.send('stop');
      await exit;
    },
  };
}

async function createProfile(home) {
  const profile = join(home, 'profiles', 'web');
  const bundle = join(profile, 'node_modules', 'updater-lifecycle-fixture');
  await mkdir(bundle, { recursive: true });
  const plugin = `
export const name = 'updater-lifecycle-fixture';
export function apply(ctx) {
  const emit = (event, fields = {}) => process.stdout.write('UPDATER_FIXTURE ' + JSON.stringify({ event, ...fields }) + '\\n');
  const originalFetch = globalThis.fetch;
  ctx.on('hmr/config-update-failed', (filename, error) => emit('refresh-failed', { filename, error: error.stack }));
  globalThis.fetch = async () => new Response('Fixture networking is disabled', { status: 503 });
  const register = kind => definition => {
    emit('registered:' + definition.name, { kind });
    if (kind === 'command') void definition.handler({ rawInput: '', signal: new AbortController().signal })
      .then(result => emit('command-result', { result }), error => emit('command-failed', { message: String(error) }));
    return () => emit('removed:' + definition.name, { kind });
  };
  ctx.provide('commands', { register: register('command') });
  ctx.provide('tools', { register: register('tool') });
  ctx.provide('approval', { request: async () => { throw new Error('No fixture operation is approved'); } });
  const heartbeat = setInterval(() => {}, 1000);
  const shutdown = message => { if (message === 'stop') process.emit('SIGTERM'); };
  process.on('message', shutdown);
  ctx.effect(() => () => { clearInterval(heartbeat); process.off('message', shutdown); globalThis.fetch = originalFetch; emit('fixture-disposed'); });
  ctx.effect(() => ctx.get('appReady').onReady(() => emit('ready')));
}
`;
  await writeFile(join(bundle, 'plugin.mjs'), plugin);
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'updater-lifecycle-fixture', version: '0.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: updater-lifecycle-fixture\n      name: ${JSON.stringify(pathToFileURL(join(bundle, 'plugin.mjs')).href)}\n`);
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-updater-web-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['updater-lifecycle-fixture'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), '# preserve user profile comment\n[]\n');
  return join(profile, 'cordis.patch.yml');
}

test('packed updater imports outside the checkout and hot-mounts through a running built dsh web profile', {
  skip: artifact ? false : 'Requires CLAWMASTER_UPDATER_ARCHIVE from pack:plugin', timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-updater-loader-'));
  let profile;
  try {
    const home = join(root, 'home');
    const patch = await createProfile(home);
    const original = await readFile(patch, 'utf8');
    const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const runtime = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const descriptor = { id: 'updates', packageName: packageManifest.name, version: packageManifest.version, kind: 'component',
      entry: './dist/index.js', activation: 'restart', requiresDshVersion: runtime.version };
    const installed = await installComponent({ archivePath: resolve(artifact), descriptor, dshHome: home, dshVersion: runtime.version,
      providedPackages: { '@deepseek-ai/cordis': packageManifest.peerDependencies['@deepseek-ai/cordis'] } });
    const module = await import(installed.entryUrl);
    assert.equal(module.name, 'clawmaster-updates');
    assert.deepEqual(module.inject, ['commands', 'tools', 'approval']);
    const nativeFile = join(root, 'native-signature-vector');
    await writeFile(nativeFile, 'test');
    const key = Buffer.from(verificationKey).toString('base64');
    const signature = Buffer.from(verificationSignature).toString('base64');
    await module.verifyNativeFile(nativeFile, key, signature, AbortSignal.timeout(10_000));
    await writeFile(nativeFile, 'Test');
    await assert.rejects(module.verifyNativeFile(nativeFile, key, signature, AbortSignal.timeout(10_000)), /signature verification/);
    profile = profileProcess(home);
    await profile.event('ready');
    assert.equal(profile.events.some(item => item.event === 'registered:updates'), false);
    const mounted = await bootstrapUpdater({ dshHome: home, version: descriptor.version,
      expectedPatchRevision: await readComponentPatchRevision(home), confirmed: true });
    assert.equal(mounted.status, 'activation-pending');
    await Promise.all(['updates', 'clawmaster_updates', 'clawmaster_update'].map(name => profile.event(`registered:${name}`)));
    const response = await profile.event('command-result');
    assert.equal(response.result.kind, 'success');
    assert.match(response.result.text, /当前 DSH/);
    assert.ok((await readFile(patch, 'utf8')).startsWith('# preserve user profile comment\n'));
    await unlink(patch);
    await Promise.all(['updates', 'clawmaster_updates', 'clawmaster_update'].map(name => profile.event(`removed:${name}`)));
    await writeFile(patch, original);
    assert.equal(await readFile(patch, 'utf8'), original);
  } finally {
    await profile?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
