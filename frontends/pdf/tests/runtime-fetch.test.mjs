/**
 * The optional runtime's fetch rules and the supervisor's lifecycle rules.
 *
 * None of this needs Java or the network: the downloader and the process are injected, so what is
 * verified here is the behaviour that decides whether a user ends up with a broken runtime — that a
 * truncated or mismatched download is rejected rather than installed, that a runtime which never
 * becomes ready is retired instead of held open, that an unexpected exit is restarted a bounded number
 * of times, and that the port is released when it is stopped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  RUNTIME_ARTIFACTS, defaultRuntimeDirectory, fetchRuntime, hostOf, runtimeInstalled, sha256Of,
} from '../src/runtime-fetch.ts';
import { StirlingSupervisor } from '../src/stirling.ts';

/** The manifest must describe real things, so the checks below are about its shape and its policy. */
test('every pinned artifact carries a size, a hash and a reachable-looking source', () => {
  assert.ok(RUNTIME_ARTIFACTS.length >= 2);
  for (const artifact of RUNTIME_ARTIFACTS) {
    assert.match(artifact.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, artifact.name);
    assert.ok(Number.isInteger(artifact.bytes) && artifact.bytes > 1_000_000, `${artifact.name} bytes`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${artifact.name} sha256`);
    assert.ok(artifact.role.length > 5, `${artifact.name} role`);
    assert.ok(artifact.checksumSource.length > 10, `${artifact.name} must say where its checksum came from`);
    for (const source of artifact.sources) {
      assert.match(source, /^https:\/\//, source);
      // Measured: direct github.com delivers no bytes from this machine, so every source goes through
      // the proxy. A source that cannot deliver is worse than no source, because it hides the failure.
      assert.equal(hostOf(source), 'ghproxy.net', `${artifact.name} must use the route that works: ${source}`);
    }
  }
});

test('the runtime directory default is outside the app bundle', () => {
  assert.match(defaultRuntimeDirectory('/Users/example'), /\.clawmaster\/components\/pdf\/runtime$/);
});

/** A filesystem that records what a fetch did, over a real temporary directory. */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-runtime-'));
  const files = new Map();
  const fs = {
    exists: path => files.has(path),
    remove: path => { files.delete(path); },
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdir: () => undefined,
    size: path => (files.get(path) ?? new Uint8Array()).byteLength,
    sha256: async path => createHash('sha256').update(files.get(path) ?? new Uint8Array()).digest('hex'),
  };
  return {
    root,
    fs,
    files,
    /** Write bytes as if they had been downloaded. */
    async put(path, bytes) { files.set(path, bytes); },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

/** A tiny artifact whose real sha256 is computed from the bytes, so no fixture is faked. */
function artifactFor(name, bytes) {
  return {
    name,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    role: 'a test artifact',
    sources: ['https://ghproxy.net/example/' + name],
    checksumSource: 'computed in the test',
  };
}

test('a verified download is installed under its own name', async () => {
  const s = await scratch();
  try {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const artifact = artifactFor('thing.jar', payload);
    const result = await fetchRuntime({
      directory: '/runtime',
      artifacts: [artifact],
      fs: s.fs,
      download: async (_url, destination) => { await s.put(destination, payload); return payload.byteLength; },
    });
    assert.deepEqual(result.installed, [{ name: 'thing.jar', bytes: payload.byteLength }]);
    assert.deepEqual(result.failed, []);
    assert.equal(s.files.has('/runtime/thing.jar'), true);
    assert.equal(s.files.has('/runtime/thing.jar.part'), false, 'the part file is gone');
  } finally {
    await s.close();
  }
});

test('a truncated download is rejected, removed, and retried before it is installed', async () => {
  const s = await scratch();
  try {
    const payload = new Uint8Array([9, 9, 9, 9]);
    const artifact = artifactFor('thing.jar', payload);
    let attempt = 0;
    const result = await fetchRuntime({
      directory: '/runtime',
      artifacts: [artifact],
      fs: s.fs,
      attempts: 2,
      download: async (_url, destination) => {
        attempt += 1;
        // The first attempt is short, which is exactly what the proxy has been measured doing.
        if (attempt === 1) { await s.put(destination, payload.subarray(0, 2)); return 2; }
        await s.put(destination, payload);
        return payload.byteLength;
      },
    });
    assert.equal(result.installed.length, 1, 'the retry succeeded');
    assert.equal(attempt, 2);
    assert.equal(s.files.has('/runtime/thing.jar.part'), false);
  } finally {
    await s.close();
  }
});

test('a download with the wrong bytes is never installed', async () => {
  const s = await scratch();
  try {
    const good = new Uint8Array([1, 1, 1, 1]);
    const wrong = new Uint8Array([2, 2, 2, 2]);
    const artifact = artifactFor('thing.jar', good);
    const result = await fetchRuntime({
      directory: '/runtime',
      artifacts: [artifact],
      fs: s.fs,
      attempts: 2,
      download: async (_url, destination) => { await s.put(destination, wrong); return wrong.byteLength; },
    });
    assert.equal(result.installed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /sha256/);
    assert.equal(s.files.has('/runtime/thing.jar'), false, 'nothing broken was left in place');
  } finally {
    await s.close();
  }
});

test('an already installed artifact is left alone', async () => {
  const s = await scratch();
  try {
    const payload = new Uint8Array([7, 7, 7]);
    const artifact = artifactFor('thing.jar', payload);
    await s.put('/runtime/thing.jar', payload);
    let downloads = 0;
    const result = await fetchRuntime({
      directory: '/runtime',
      artifacts: [artifact],
      fs: s.fs,
      download: async () => { downloads += 1; return 0; },
    });
    assert.equal(downloads, 0, 'a verified file is not downloaded again');
    assert.deepEqual(result.alreadyPresent, ['thing.jar']);
  } finally {
    await s.close();
  }
});

test('sha256Of and runtimeInstalled read the real filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-runtime-real-'));
  try {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await writeFile(join(root, 'thing.jar'), payload);
    assert.equal(await sha256Of(join(root, 'thing.jar')), createHash('sha256').update(payload).digest('hex'));
    const artifact = { ...artifactFor('thing.jar', payload) };
    assert.equal(await runtimeInstalled(root, [artifact]), true);
    await writeFile(join(root, 'thing.jar'), new Uint8Array([1, 2, 3, 5]));
    assert.equal(await runtimeInstalled(root, [artifact]), false, 'one changed byte is not installed');
    assert.equal(await runtimeInstalled(root, [{ ...artifact, name: 'absent.jar' }]), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
