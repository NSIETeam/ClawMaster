import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createManifest, normalizedAssets } from './generate-updater-manifest.mjs'
import { verifyUpdaterSignatures } from './verify-updater-signatures.mjs'

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
const version = '0.2.1'
const assets = normalizedAssets(version)
const minisign = process.env.CLAWMASTER_MINISIGN ?? 'minisign'
const encode = value => Buffer.from(value).toString('base64')

async function withRelease(run, targetSet = 'current') {
  const assets = normalizedAssets(version, targetSet)
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-signed-release-'))
  try {
    const manifest = createManifest({
      version, targetSet, repository: 'NSIETeam/ClawMaster-Desktop', releaseTag: `desktop-v${version}`,
      notes: '', pubDate: '2026-09-15T00:00:00.000Z',
      signatures: Object.fromEntries(Object.keys(assets).map((target, index) => [target, encode(signatures[index % signatures.length])])),
    })
    const options = { assetsDir: directory, manifestPath: join(directory, 'latest.json'), publicKeyPath: join(directory, 'signing.pub'), minisign }
    await writeFile(options.publicKeyPath, encode(publicKey))
    await writeFile(options.manifestPath, JSON.stringify(manifest))
    for (const [target, asset] of Object.entries(assets)) {
      await writeFile(join(directory, asset), 'test')
      await writeFile(join(directory, `${asset}.sig`), `${manifest.platforms[target].signature}\n`)
    }
    await run({ directory, manifest, options, assets })
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function rejectsSignature(options, asset) {
  await assert.rejects(verifyUpdaterSignatures(options), error => {
    assert.match(error.message, new RegExp(`signature verification failed.*${asset}`))
    assert.equal(error.cause.code, 1)
    assert.equal(error.cause.signal, null)
    assert.equal(error.cause.killed, false)
    return true
  })
}

test('the release CLI authenticates every platform using real legacy and prehashed signatures', async () => {
  await withRelease(async ({ options }) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./verify-updater-signatures.mjs', import.meta.url)),
      options.assetsDir, options.manifestPath, options.publicKeyPath, minisign,
    ])
    assert.match(stdout, /verified 4 updater artifacts/)
  })
})

test('legacy five-target manifests authenticate the additional Intel artifact', async () => {
  await withRelease(async ({ directory, options, assets }) => {
    assert.equal((await verifyUpdaterSignatures(options)).length, 5)
    await writeFile(join(directory, assets['darwin-x86_64']), 'Test')
    await rejectsSignature(options, 'macos-x64')
  }, 'legacy')
})

test('changing updater bytes is rejected by Minisign', async () => {
  await withRelease(async ({ directory, options }) => {
    await writeFile(join(directory, assets['linux-x86_64-deb']), 'Test')
    await rejectsSignature(options, 'linux-x64\\.deb')
  })
})

test('a corrupted signature in both the manifest and sidecar is rejected by Minisign', async () => {
  await withRelease(async ({ directory, manifest, options }) => {
    const target = 'windows-x86_64'
    const corrupted = encode(signatures[0].replace('9SLO', '9TLO'))
    manifest.platforms[target].signature = corrupted
    await writeFile(options.manifestPath, JSON.stringify(manifest))
    await writeFile(join(directory, `${assets[target]}.sig`), corrupted)
    await rejectsSignature(options, 'windows-x64')
  })
})

test('signatures made for a different public key cannot enter the release', async () => {
  await withRelease(async ({ options }) => {
    const releaseKey = await readFile(new URL('../release-signing.pub', import.meta.url), 'utf8')
    await writeFile(options.publicKeyPath, releaseKey)
    await rejectsSignature(options, 'windows-x64')
  })
})

test('an unverified extra platform or a URL naming different bytes cannot enter the manifest', async () => {
  await withRelease(async ({ manifest, options }) => {
    manifest.platforms['unverified-target'] = manifest.platforms['windows-x86_64']
    await writeFile(options.manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyUpdaterSignatures(options), /exactly a supported .* platform target set/u)
    delete manifest.platforms['unverified-target']
    manifest.platforms['windows-x86_64'].url = 'https://example.test/different.exe'
    await writeFile(options.manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyUpdaterSignatures(options), /URL does not name the verified artifact/)
  })
})

test('empty or malformed public-key envelopes fail before running the verifier', async () => {
  await withRelease(async ({ options }) => {
    await writeFile(options.publicKeyPath, '')
    await assert.rejects(verifyUpdaterSignatures(options), /Missing updater public key/)
    await writeFile(options.publicKeyPath, 'not!base64')
    await assert.rejects(verifyUpdaterSignatures(options), /Invalid base64 updater public key/)
  })
})

test('missing targets and manifest-sidecar disagreement fail before publication', async () => {
  await withRelease(async ({ manifest, options }) => {
    const target = 'linux-x86_64-deb'
    const entry = manifest.platforms[target]
    delete manifest.platforms[target]
    await writeFile(options.manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyUpdaterSignatures(options), /exactly a supported .* platform target set/u)
    manifest.platforms[target] = { ...entry, signature: 'different' }
    await writeFile(options.manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyUpdaterSignatures(options), /differs from its sidecar/)
  })
})

test('a missing verifier fails closed', async () => {
  await withRelease(async ({ directory, options }) => {
    await assert.rejects(verifyUpdaterSignatures({ ...options, minisign: join(directory, 'missing-verifier') }), /signature verification failed.*ENOENT/)
  })
})
