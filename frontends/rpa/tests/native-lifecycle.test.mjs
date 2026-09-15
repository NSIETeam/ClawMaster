/** Owned subprocesses are bounded, scrubbed and reaped before a read settles. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
  const connections = new Set();
  const server = createServer(connection => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
  });
  server.maxConnections = 1;
  const controller = new AbortController();
  const readiness = new AbortController();
  const deadline = AbortSignal.any([AbortSignal.timeout(15_000), readiness.signal]);
  let socket, pending;
  t.after(async () => {
    controller.abort();
    const closed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    for (const connection of connections) connection.destroy();
    await pending?.catch(() => {});
    await closed;
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const source = `import {connect} from 'node:net';
const socket=connect(${server.address().port},'127.0.0.1');
socket.once('connect',()=>socket.end(String(process.pid)));socket.on('error',()=>process.exit(2));setInterval(()=>{},1000);`;
  const connected = once(server, 'connection', { signal: deadline });
  pending = createNativeHelper({ command: process.execPath, args: ['--input-type=module', '-e', source, '--'] })
    .run('wechat-read-selected', [], controller.signal);
  void pending.catch(error => readiness.abort(error));
  [socket] = await connected;
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; if (received.length > 32) readiness.abort(new Error('Invalid ready PID')); });
  await once(socket, 'end', { signal: deadline });
  assert.match(received, /^[1-9]\d{0,9}$/u);
  const pid = Number(received);
  assert.doesNotThrow(() => process.kill(pid, 0), 'the helper must be running when cancellation starts');
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
