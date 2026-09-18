/**
 * The supervisor's lifecycle rules: nothing starts unless asked, a runtime that never answers is
 * retired, an exit is restarted a bounded number of times, and the port is released on stop.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StirlingSupervisor } from '../src/stirling.ts';

/** A child process a test can drive by hand. */
function fakeProcess(pid = 4242) {
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const signals = [];
  return {
    signals,
    process: {
      pid,
      exited: () => exited,
      signal: signal => { signals.push(signal); },
    },
    exit: code => resolveExit({ code }),
  };
}

/** Supervise with an injected clock and sleep, so the tests take no real time. */
function supervisor(overrides = {}) {
  const children = [];
  const states = [];
  let now = 1000;
  const instance = new StirlingSupervisor({
    java: '/runtime/jre/bin/java',
    jar: '/runtime/Stirling-PDF-server.jar',
    port: 19_001,
    spawn: (command, args) => {
      const child = fakeProcess(1000 + children.length);
      children.push({ command, args, ...child });
      return child.process;
    },
    probe: async () => true,
    sleep: async () => { now += 1000; },
    now: () => now,
    onState: state => states.push(state),
    ...overrides,
  });
  return { instance, children, states, tick: ms => { now += ms; } };
}

test('starting spawns the runtime on the loopback interface with the configured port', async () => {
  const h = supervisor();
  const state = await h.instance.start();
  assert.equal(state.state, 'ready');
  assert.equal(state.port, 19_001);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.children[0].args.slice(-2), ['--server.address=127.0.0.1', '--server.port=19001']);
  assert.equal(h.instance.running, true);
  assert.deepEqual(h.states.map(entry => entry.state), ['starting', 'ready']);
  await h.instance.stop();
  assert.deepEqual(h.states.at(-1), { state: 'stopped' });
});

test('a second start while one is running does not launch a second JVM', async () => {
  const h = supervisor();
  await h.instance.start();
  await h.instance.start();
  assert.equal(h.children.length, 1);
  await h.instance.stop();
});

test('a runtime that never answers is retired, and the port is released', async () => {
  const h = supervisor({ probe: async () => false, readyTimeoutMs: 3000 });
  const state = await h.instance.start();
  assert.equal(state.state, 'failed');
  assert.match(state.reason, /did not answer on 127\.0\.0\.1:19001/);
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].signals.includes('SIGTERM'), true, 'the useless process was told to stop');
  assert.equal(h.instance.running, false);
});

test('a stop signals the process and a stubborn one is killed', async () => {
  const h = supervisor();
  await h.instance.start();
  const child = h.children[0];
  // Never resolve the exit, so the grace period has to expire.
  const stopping = h.instance.stop();
  await stopping;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.instance.running, false);
});

test('an unexpected exit is restarted a bounded number of times and then retired', async () => {
  const h = supervisor({ maxRestarts: 1, probe: async () => true });
  await h.instance.start();
  const first = h.children[0];
  first.exit(1);
  // Let the watcher run.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.children.length, 2, 'it restarted once');
  const second = h.children[1];
  second.exit(1);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.children.length, 2, 'the restart limit is honoured');
  assert.equal(h.instance.state.state, 'failed');
  assert.match(h.instance.state.reason, /built-in PDF tools still work/);
});

test('a failure to launch is reported rather than thrown', async () => {
  const h = supervisor({ spawn: () => { throw new Error('ENOENT: no such file, java'); } });
  const state = await h.instance.start();
  assert.equal(state.state, 'failed');
  assert.match(state.reason, /Could not launch the optional runtime: ENOENT/);
  assert.equal(h.instance.running, false);
});

test('the supervisor never lets a probe rejection escape as a thrown error', async () => {
  // A probe that throws — a refused connection, a malformed response — must read as "not ready" so the
  // supervisor can retire the track instead of failing the whole component.
  const h = supervisor({ probe: async () => { throw new Error('ECONNREFUSED'); }, readyTimeoutMs: 2000 });
  const state = await h.instance.start();
  assert.equal(state.state, 'failed');
  assert.match(state.reason, /did not answer/);
});
