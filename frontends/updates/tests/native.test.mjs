import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { fetchNativeRelease, prepareNativeUpdate, verifyNativeFile } from '../src/native.ts'

// Public test vectors from jedisct1/rust-minisign-verify cover both Tauri's legacy format and prehashing.
const publicKey = `untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
`
const signatures = [
  `untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==
`,
  `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==
`,
]

const encode = value => Buffer.from(value).toString('base64')
const suffixes = { 'windows-x86_64': 'windows-x64-setup.exe', 'darwin-x86_64': 'macos-x64.app.tar.gz', 'darwin-aarch64': 'macos-arm64.app.tar.gz', 'linux-x86_64': 'linux-x64.AppImage', 'linux-x86_64-deb': 'linux-x64.deb' }
function manifest(endpoint = 'https://updates.test/updates/clawmaster/latest.json') {
  return { version: '0.2.1', notes: '', pub_date: '2026-09-15T00:00:00Z', platforms: Object.fromEntries(Object.entries(suffixes).map(([target, suffix], index) => [target, { url: new URL(`versions/0.2.1/clawmaster-0.2.1-${suffix}`, endpoint).href, signature: encode(signatures[index % signatures.length]) }])) }
}
async function fixture(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'clawmaster-native-stage-'))
  t.after(() => rm(cacheDir, { recursive: true, force: true }))
  return { cacheDir, publicKey: encode(publicKey), maxDownloadBytes: 1000, downloadTimeoutMs: 30000, fetchImpl: async () => new Response('test') }
}

test('real legacy and prehashed Minisign signatures stage native files without running an installer', async t => {
  const options = await fixture(t)
  const release = manifest()
  for (const target of ['windows-x86_64', 'darwin-x86_64']) {
    const prepared = await prepareNativeUpdate(release, target, options)
    assert.equal(prepared.status, 'requires-native-installer')
    assert.equal(prepared.version, '0.2.1')
    assert.equal(await readFile(prepared.path, 'utf8'), 'test')
  }
  assert.equal((await readdir(options.cacheDir)).length, 1)
})

test('bad payload, key and signature never enter the native cache', async t => {
  const options = await fixture(t)
  const release = manifest()
  await assert.rejects(prepareNativeUpdate(release, 'windows-x86_64', { ...options, fetchImpl: async () => new Response('Test') }), /signature verification/)
  const changed = structuredClone(release)
  changed.platforms['windows-x86_64'].signature = encode(signatures[0].replace('9SLO', '9TLO'))
  await assert.rejects(prepareNativeUpdate(changed, 'windows-x86_64', options), /signature verification/)
  await assert.rejects(prepareNativeUpdate(release, 'windows-x86_64', { ...options, publicKey: 'invalid!' }), /public key envelope/)
  await assert.rejects(prepareNativeUpdate(release, 'windows-x86_64', { ...options, publicKey: encode(publicKey.replace('73Y7', '73Y8')) }), /signature verification/)
  assert.deepEqual(await readdir(options.cacheDir), [])
})

test('four-target releases use the new channel and every shipped native payload remains verifiable', async t => {
  const options = await fixture(t)
  const config = resolveConfig()
  const release = manifest(config.nativeManifestUrl)
  delete release.platforms['darwin-x86_64']
  assert.equal(config.nativeManifestUrl, 'https://8.140.52.117/updates/clawmaster/v2/latest.json')
  assert.equal(config.catalogUrl, 'https://8.140.52.117/updates/clawmaster/components/catalog.json')
  const request = { manifestUrl: config.nativeManifestUrl, requestTimeoutMs: 30000, maxCatalogBytes: 10000 }
  const parsed = await fetchNativeRelease({ ...request, fetchImpl: async () => new Response(JSON.stringify(release)) })
  assert.deepEqual(parsed, release)
  for (const target of Object.keys(parsed.platforms)) {
    const prepared = await prepareNativeUpdate(parsed, target, options)
    assert.equal(prepared.target, target)
    assert.equal(await readFile(prepared.path, 'utf8'), 'test')
  }
})

test('native channels reject cross-channel, escaped version directories and changed filenames', async () => {
  const current = resolveConfig().nativeManifestUrl
  const legacy = current.replace('/v2/latest.json', '/latest.json')
  for (const endpoint of [legacy, current]) {
    const release = manifest(endpoint)
    for (const changed of [
      manifest(endpoint === current ? legacy : current).platforms['windows-x86_64'].url,
      release.platforms['windows-x86_64'].url.replace('/versions/', '/../versions/'),
      release.platforms['windows-x86_64'].url.replace('/0.2.1/', '/0.2.0/'),
      release.platforms['windows-x86_64'].url.replace('/versions/', '/%2e%2e/versions/'),
      release.platforms['windows-x86_64'].url.replace('windows-x64-setup.exe', 'macos-arm64.app.tar.gz'),
      release.platforms['windows-x86_64'].url + '?redirect=other',
    ]) {
      const invalid = structuredClone(release)
      invalid.platforms['windows-x86_64'].url = changed
      await assert.rejects(fetchNativeRelease({ manifestUrl: endpoint, requestTimeoutMs: 30000, maxCatalogBytes: 10000,
        fetchImpl: async () => new Response(JSON.stringify(invalid)) }))
    }
  }
})

test('a release without Intel Mac refuses that target before any fetch or cache write', async t => {
  const options = await fixture(t)
  const release = manifest()
  delete release.platforms['darwin-x86_64']
  await assert.rejects(prepareNativeUpdate(release, 'darwin-x86_64', {
    ...options, cacheDir: join(options.cacheDir, 'not-created'),
    fetchImpl: async () => assert.fail('Unavailable targets cannot download'),
  }), /No native installer for darwin-x86_64 in ClawMaster 0\.2\.1/)
  assert.deepEqual(await readdir(options.cacheDir), [])
})

test('native manifests reject missing required targets, unknown targets, prereleases and unexpected origins or paths', async () => {
  const options = { manifestUrl: 'https://updates.test/updates/clawmaster/latest.json', requestTimeoutMs: 30000, maxCatalogBytes: 10000 }
  const release = manifest()
  assert.deepEqual(await fetchNativeRelease({ ...options, fetchImpl: async () => new Response(JSON.stringify(release)) }), release)
  for (const change of [
    ...Object.keys(suffixes).filter(target => target !== 'darwin-x86_64').map(target => value => { delete value.platforms[target] }),
    value => { value.platforms['unknown-target'] = value.platforms['windows-x86_64'] },
    value => { value.platforms['darwin-x86_64'].url = 'https://other.test/old-mac.tar.gz' },
    value => { value.version = '0.2.2-beta.1' },
    value => { value.platforms['windows-x86_64'].url = 'https://other.test/updates/clawmaster/versions/0.2.1/clawmaster-0.2.1-windows-x64-setup.exe' },
    value => { value.platforms['windows-x86_64'].url = 'https://updates.test/updates/clawmaster/versions/0.2.1/wrong.exe' },
    value => { value.unknown = true },
  ]) {
    const value = structuredClone(release)
    change(value)
    await assert.rejects(fetchNativeRelease({ ...options, fetchImpl: async () => new Response(JSON.stringify(value)) }))
  }
})

test('aborting a signature worker reaches exit before returning', async t => {
  const options = await fixture(t)
  const path = join(options.cacheDir, 'test-file')
  await writeFile(path, 'test')
  const controller = new AbortController()
  const result = verifyNativeFile(path, encode(publicKey), encode(signatures[0]), controller.signal)
  controller.abort(new Error('verification cancelled'))
  await assert.rejects(result, /verification cancelled/)
  await rm(path)
  assert.deepEqual(await readdir(options.cacheDir), [])
})
