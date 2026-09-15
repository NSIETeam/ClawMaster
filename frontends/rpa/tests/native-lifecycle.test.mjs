/** Owned subprocesses are bounded, scrubbed and reaped before a read settles. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createNativeHelper } from '../dist/index.js';

async function fixture(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), 'clawmaster-helper-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'helper.mjs');
  await writeFile(script, source);
  return { root, script, spec: { command: process.execPath, args: [script] } };
}

test('the helper does not inherit credentials or dynamic loader injection', async t => {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const f = await fixture(t, `import {createNativeHelper} from ${JSON.stringify(moduleUrl)};
process.env.TEST_API_KEY='synthetic';process.env.NODE_OPTIONS='--import=/does-not-exist';
process.env.DYLD_INSERT_LIBRARIES='/does-not-exist';process.env.TEST_TOKEN='synthetic';
const helper=createNativeHelper({command:process.execPath,args:['-e', 'process.stdout.write(JSON.stringify({key:!!process.env.TEST_API_KEY,token:!!process.env.TEST_TOKEN,loader:!!process.env.NODE_OPTIONS,dylib:!!process.env.DYLD_INSERT_LIBRARIES,path:!!process.env.PATH}))','--']});
process.stdout.write(JSON.stringify(await helper.run('capabilities')));`);
  const { stdout } = await promisify(execFile)(process.execPath, [f.script]);
  assert.deepEqual(JSON.parse(stdout), { key: false, token: false, loader: false, dylib: false, path: true });
});

for (const stream of ['stdout', 'stderr']) {
  test(`unbounded ${stream} is rejected without returning its contents`, async t => {
    const f = await fixture(t, `process.${stream}.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`);
    await assert.rejects(createNativeHelper(f.spec).run('wechat-read-selected'), /exceeded the output limit/u);
  });
}

test('an aborted read rejects only after the ready native process has exited', async t => {
  const f = await fixture(t, `import {writeFileSync,renameSync} from 'node:fs';import path from 'node:path';
const root=path.dirname(process.argv[1]);writeFileSync(path.join(root,'ready.tmp'),String(process.pid));
renameSync(path.join(root,'ready.tmp'),path.join(root,'ready'));setInterval(()=>{},1000);`);
  const deadline = AbortSignal.timeout(15_000);
  const events = watch(f.root, { signal: deadline });
  const ready = (async () => {
    for await (const event of events) if (event.filename === 'ready') return Number(await readFile(path.join(f.root, 'ready'), 'utf8'));
    throw new Error('helper did not report readiness');
  })();
  const controller = new AbortController();
  const pending = createNativeHelper(f.spec).run('wechat-read-selected', [], controller.signal);
  t.after(async () => { controller.abort(); await pending.catch(() => {}); await events.return(); });
  const pid = await ready;
  await events.return();
  controller.abort();
  await assert.rejects(pending, /cancelled/u);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('a pre-aborted request never executes the helper', async t => {
  const f = await fixture(t, "throw new Error('must not start');");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createNativeHelper(f.spec).run('wechat-read-selected', [], controller.signal), /before it started/u);
});
