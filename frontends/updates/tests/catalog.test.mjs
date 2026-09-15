import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { fetchCatalog, parseSignedCatalog } from '../src/catalog.ts'

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const options = { catalogUrl: 'https://updates.test/updates/clawmaster/components/catalog.json', publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }), maxDownloadBytes: 1000, maxCatalogBytes: 10000, requestTimeoutMs: 30000 }
  const catalog = { schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [{ id: 'notes', packageName: '@clawmaster/dsh-notes', kind: 'component', version: '0.1.0', entry: './dist/index.js', activation: 'hot', requiresDshVersion: '0.1.5-rc.2', url: 'https://updates.test/updates/clawmaster/components/artifacts/notes-0.1.0.tgz', sha256: 'a'.repeat(64), size: 4 }] }
  const encode = value => {
    const bytes = Buffer.from(JSON.stringify(value))
    return [bytes, sign(null, bytes, privateKey).toString('base64')]
  }
  return { options, catalog, encode }
}

test('exact Ed25519 bytes are authenticated before accepting a component catalog', async () => {
  const { options, catalog, encode } = fixture()
  const [bytes, signature] = encode(catalog)
  assert.deepEqual(parseSignedCatalog(bytes, signature, options), catalog)
  const calls = []
  const fetched = await fetchCatalog({ ...options, fetchImpl: async (url, init) => {
    calls.push(url)
    assert.equal(init.redirect, 'error')
    return new Response(url.endsWith('.sig') ? signature : bytes)
  } })
  assert.deepEqual(fetched, catalog)
  assert.deepEqual(calls, [options.catalogUrl, `${options.catalogUrl}.sig`])
  assert.throws(() => parseSignedCatalog(Buffer.concat([bytes, Buffer.from(' ')]), signature, options), /signature verification/)
  assert.throws(() => parseSignedCatalog(bytes, 'bad!', options), /signature encoding/)
  assert.throws(() => parseSignedCatalog(bytes, signature, fixture().options), /signature verification/)
})

test('authenticated malformed or ambiguous catalogs still fail validation', () => {
  const { options, catalog, encode } = fixture()
  const invalid = [
    value => { value.schemaVersion = 2 },
    value => { value.unknown = true },
    value => { value.components.push({ ...value.components[0] }) },
    value => { value.components[0].version = '1.0.0-beta.1' },
    value => { value.components[0].requiresDshVersion = '^0.1.5' },
    value => { value.components[0].entry = '../index.js' },
    value => { value.components[0].size = 1001 },
    value => { value.components[0].kind = 'runtime' },
    value => { value.components[0].sha256 = 'broken' },
  ]
  for (const change of invalid) {
    const value = structuredClone(catalog)
    change(value)
    assert.throws(() => parseSignedCatalog(...encode(value), options))
  }
  for (const url of ['http://updates.test/updates/clawmaster/components/artifacts/a.tgz', 'https://other.test/updates/clawmaster/components/artifacts/a.tgz', 'https://updates.test/updates/clawmaster/components/artifacts/../private.tgz', 'https://updates.test/updates/clawmaster/components/artifacts/%2e%2e/private.tgz', 'https://updates.test/updates/clawmaster/components/artifacts/%252e%252e.tgz', 'https://updates.test/updates/clawmaster/components/artifacts/a%2fb.tgz', 'https://user:secret@updates.test/updates/clawmaster/components/artifacts/a.tgz', 'https://updates.test/updates/clawmaster/components/artifacts/a.tgz?q=1']) {
    const value = structuredClone(catalog)
    value.components[0].url = url
    assert.throws(() => parseSignedCatalog(...encode(value), options))
  }
})

test('metadata byte limits and cancellation apply before parsing', async () => {
  const { options } = fixture()
  await assert.rejects(fetchCatalog({ ...options, maxCatalogBytes: 2, fetchImpl: async () => new Response('too large') }), /byte limit/)
  await assert.rejects(fetchCatalog({ ...options, signal: AbortSignal.abort(new Error('cancelled')), fetchImpl: async () => { throw new Error('must not fetch') } }), /cancelled/)
})

test('signed DSH source archives require desktop support and have no plugin entry', () => {
  const { options, catalog, encode } = fixture()
  const runtime = {
    id: 'dsh-runtime', packageName: '@deepseek-ai/dsh-app-boot', kind: 'runtime', version: '0.2.1',
    activation: 'desktop-required', requiresDshVersion: '0.1.5-rc.2',
    url: 'https://updates.test/updates/clawmaster/components/artifacts/dsh-runtime-0.2.1.tar.gz',
    sha256: 'b'.repeat(64), size: 100,
  }
  catalog.components = [runtime]
  assert.deepEqual(parseSignedCatalog(...encode(catalog), options).components, [runtime])
  for (const changed of [{ ...runtime, entry: './dist/index.js' }, { ...runtime, activation: 'hot' }, { ...runtime, activation: 'restart' }]) {
    assert.throws(() => parseSignedCatalog(...encode({ ...catalog, components: [changed] }), options))
  }
  const component = fixture().catalog.components[0]
  assert.throws(() => parseSignedCatalog(...encode({ ...catalog, components: [{ ...component, activation: 'desktop-required' }] }), options))
})
