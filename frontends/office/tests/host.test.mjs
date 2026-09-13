/** The production Host rejects unverified resources and unauthenticated or escaping requests. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { build } from 'esbuild';
import test from 'node:test';
import { assertPortableNpmLock, digest, MANIFEST, tree } from '../scripts/runtime.mjs';

test('independent build locks reject local symlinks and filesystem dependencies', async () => {
  assertPortableNpmLock(JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url))));
  for (const packages of [
    { 'node_modules/fflate': { link: true, resolved: '../../node_modules/fflate' } },
    { '../other/node_modules/fflate': { version: '0.8.3' } },
    { 'node_modules/fflate': { resolved: 'file:/developer/fflate' } },
  ]) assert.throws(() => assertPortableNpmLock({ packages }), /local installation reference/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-office-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<h1>Office fixture</h1>');
  await writeFile(join(root, 'engine.wasm'), Buffer.from([0, 97, 115, 109]));
  const bytes = JSON.stringify({ schemaVersion: 1, upstream: { repository: 'fixture', commit: 'fixture', releaseTag: 'fixture', archiveUrl: 'https://example.invalid/fixture.zip', archiveSha256: '0'.repeat(64) }, files: await tree(root) });
  await writeFile(join(root, MANIFEST), bytes);
  const result = await build({ absWorkingDir: new URL('..', import.meta.url).pathname, entryPoints: ['src/host.ts'], bundle: true, platform: 'node', format: 'esm', write: false, define: { __OFFICE_RUNTIME_MANIFEST_SHA256__: JSON.stringify(digest(bytes)) } });
  const plugin = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  return { root, plugin };
}
test('startup rejects changed, extra, missing and linked resources', async t => {
  for (const mutate of [
    root => writeFile(join(root, 'index.html'), 'changed'),
    root => writeFile(join(root, 'extra.txt'), 'extra'),
    root => rm(join(root, 'index.html')),
    async root => { await rm(join(root, 'index.html')); await symlink(join(root, 'engine.wasm'), join(root, 'index.html')); },
    root => writeFile(join(root, MANIFEST), '{}'),
  ]) {
    const { root, plugin } = await fixture(t);
    await plugin.verifyOfficeRuntime(root);
    await mutate(root);
    await assert.rejects(plugin.verifyOfficeRuntime(root));
  }
});
class Response extends Writable {
  code; headers; chunks = [];
  writeHead(code, headers) { this.code = code; this.headers = headers; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
}
test('route checks the DSH authentication owner, methods, paths, MIME and post-startup identity', async t => {
  const { root, plugin } = await fixture(t);
  let handler; let cleanup; let rejection;
  await plugin.apply({ connection: { requestRejection: () => rejection }, effect: async setup => { cleanup = await setup(); }, webServer: { register: route => { handler = route.handler; return () => { handler = undefined; }; } } }, { runtimeRoot: root });
  t.after(() => cleanup());
  const request = async (url, method = 'GET') => { const response = new Response(); await handler({ url, method }, response); return response; };
  rejection = 401; assert.equal((await request('/clawmaster/office/runtime/index.html')).code, 401);
  rejection = 403; assert.equal((await request('/clawmaster/office/runtime/index.html')).code, 403);
  rejection = undefined;
  assert.equal((await request('/clawmaster/office/runtime/index.html', 'POST')).code, 405);
  for (const path of ['../LICENSE', '%2e%2e/LICENSE', '%252e%252e/LICENSE', 'a%2fb', 'a%5cb']) assert.equal((await request(`/clawmaster/office/runtime/${path}`)).code, 403);
  assert.equal((await request('/clawmaster/office/runtime/%xy')).code, 400);
  assert.equal((await request('/clawmaster/office/runtime/missing')).code, 404);
  const head = await request('/clawmaster/office/runtime/engine.wasm', 'HEAD');
  assert.equal(head.code, 200); assert.equal(head.headers['content-type'], 'application/wasm'); assert.equal(head.chunks.length, 0);
  const body = await request('/clawmaster/office/runtime/index.html'); assert.equal(Buffer.concat(body.chunks).toString(), '<h1>Office fixture</h1>');
  assert.ok(body.headers['content-security-policy'].includes("connect-src 'self' blob: data:"));
  await writeFile(join(root, 'index.html'), 'changed after startup');
  await assert.rejects(request('/clawmaster/office/runtime/index.html'), /changed after startup/);
});
