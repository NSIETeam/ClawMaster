import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { downloadVerifiedFile } from '../src/download.ts'

const sha256 = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'clawmaster-update-download-'))
  t.after(() => rm(cacheDir, { recursive: true, force: true }))
  return { cacheDir, maxDownloadBytes: 1000, downloadTimeoutMs: 30000, fetchImpl: async () => new Response('test') }
}
const input = { url: 'https://updates.test/file.tgz', size: 4, sha256: sha256('test') }

test('verified downloads converge concurrently on an immutable cache without staging residue', async t => {
  const options = await fixture(t)
  const files = await Promise.all([downloadVerifiedFile(input, options), downloadVerifiedFile(input, options)])
  assert.equal(files[0].path, files[1].path)
  assert.equal(await readFile(files[0].path, 'utf8'), 'test')
  assert.deepEqual(await readdir(options.cacheDir), [`sha256-${input.sha256}`])
  await writeFile(files[0].path, 'Test')
  await assert.rejects(downloadVerifiedFile(input, options), /Immutable update cache/)
  assert.equal(await readFile(files[0].path, 'utf8'), 'Test')
})

test('hash, size, signature, and network failures never publish bytes', async t => {
  const options = await fixture(t)
  for (const [changed, settings, pattern] of [
    [{ ...input, sha256: 'a'.repeat(64) }, options, /SHA-256 mismatch/],
    [{ ...input, size: 3 }, options, /byte limit/],
    [{ ...input, size: 5 }, options, /size mismatch/],
    [input, { ...options, verify: async () => { throw new Error('signature rejected') } }, /signature rejected/],
    [input, { ...options, fetchImpl: async () => new Response('no', { status: 503 }) }, /HTTP 503/],
    [{ url: input.url }, options, /requires an expected hash/],
  ]) {
    await assert.rejects(downloadVerifiedFile(changed, settings), pattern)
    assert.deepEqual(await readdir(options.cacheDir), [])
  }
})

test('caller cancellation waits for verification completion and removes private staging', async t => {
  const options = await fixture(t)
  const controller = new AbortController()
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const pending = downloadVerifiedFile(input, { ...options, signal: controller.signal, verify: async (_path, signal) => {
    entered()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  await ready
  controller.abort(new Error('user cancelled'))
  await assert.rejects(pending, /user cancelled/)
  assert.deepEqual(await readdir(options.cacheDir), [])
})
