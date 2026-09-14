/** Real HTTP responses exercise the release downloader's narrow retry behavior. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadOfficeArchive } from './prepare-office-runtime.mjs';

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-office-download-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(respond);
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/release.zip`, archive: join(root, 'release.zip') };
}

test('a transient 504 retries the immutable download and preserves the successful bytes', { timeout: 15000 }, async t => {
  let requests = 0;
  const f = await fixture(t, (_request, response) => {
    if (++requests === 1) { response.writeHead(504); response.end('temporary gateway failure'); }
    else { response.writeHead(200); response.end('hash-verification-owned-by-office-preparer'); }
  });
  await downloadOfficeArchive(f.url, f.archive);
  assert.equal(requests, 2);
  assert.equal(await readFile(f.archive, 'utf8'), 'hash-verification-owned-by-office-preparer');
});

test('a permanent authorization failure is not retried', { timeout: 15000 }, async t => {
  let requests = 0;
  const f = await fixture(t, (_request, response) => { requests++; response.writeHead(401); response.end('denied'); });
  await assert.rejects(downloadOfficeArchive(f.url, f.archive));
  assert.equal(requests, 1);
});
