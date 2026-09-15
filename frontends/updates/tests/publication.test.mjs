import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readlink, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { create as createTar } from 'tar'

const execute = promisify(execFile)
const publisher = fileURLToPath(new URL('../scripts/publish-catalog.mjs', import.meta.url))
const signer = fileURLToPath(new URL('../scripts/sign-catalog.mjs', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// Publication uses server-side symlinks and a caller-held POSIX lock.
const serverOnly = { skip: process.platform === 'win32' ? 'Publication targets a POSIX server' : false }

async function fixture(run) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'clawmaster-publication-'))
  try {
    const pair = generateKeyPairSync('ed25519')
    const publicPath = join(root, 'component.pub')
    const privatePath = join(root, 'component.key')
    await writeFile(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    await writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const state = join(root, 'public')
    await mkdir(state)
    let count = 0
    async function input(version = '0.2.0', options = {}) {
      const directory = join(root, `input-${count++}`)
      await mkdir(directory)
      const id = options.id ?? 'notes'
      const content = Buffer.from(options.content ?? `verified archive ${version}`)
      const filename = `${id}-${version}.tgz`
      const item = { id, packageName: `@clawmaster/dsh-${id}`, kind: 'component', version,
        entry: './dist/index.js', activation: id === 'updates' ? 'restart' : 'hot', requiresDshVersion: '0.1.5-rc.2',
        url: `https://8.140.52.117/updates/clawmaster/components/artifacts/${id}/${version}/${filename}`,
        sha256: sha256(content), size: content.length }
      const catalog = { schemaVersion: 1, generatedAt: options.generatedAt ?? '2026-09-15T03:00:00Z', components: [item] }
      async function seal(key = pair.privateKey) {
        const bytes = Buffer.from(JSON.stringify(catalog))
        await writeFile(join(directory, 'catalog.json'), bytes)
        await writeFile(join(directory, 'catalog.json.sig'), `${sign(null, bytes, key).toString('base64')}\n`)
        return bytes
      }
      await writeFile(join(directory, filename), content)
      await seal()
      if (id === 'updates') {
        const utility = Buffer.from('export const installer = true;\n')
        const filename = `install-updates-${version}.mjs`
        await writeFile(join(directory, filename), utility)
        await writeFile(join(directory, `${filename}.sig`), `${sign(null, Buffer.concat([Buffer.from(`clawmaster-installer\0${filename}\0`), utility]), pair.privateKey).toString('base64')}\n`)
      }
      return { directory, catalog, item, content, filename, seal }
    }
    async function publish(candidate, expectedError) {
      try {
        const result = await execute(process.execPath, [publisher, '--input', candidate.directory, '--state', state, '--public-key', publicPath], { env, timeout: 30_000, maxBuffer: 128 * 1024 })
        if (expectedError) assert.fail(`Publication unexpectedly succeeded: ${expectedError}`)
        return JSON.parse(result.stdout)
      } catch (error) {
        if (!expectedError) throw error
        assert.equal(error.killed, false, 'publisher must fail itself, not through the subprocess timeout')
        assert.equal(error.signal, null)
        assert.equal(error.code, 1)
        assert.match(error.stderr, expectedError)
      }
    }
    async function snapshot() {
      const pointer = await readlink(join(state, 'current'))
      return { pointer, catalog: await readFile(join(state, pointer, 'catalog.json'), 'utf8'), signature: await readFile(join(state, pointer, 'catalog.json.sig'), 'utf8') }
    }
    await run({ root, pair, publicPath, privatePath, state, input, publish, snapshot })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('the publisher verifies a signed catalog and publishes complete artifacts before its current pointer', serverOnly, async () => fixture(async ({ pair, state, input, publish, snapshot }) => {
  const candidate = await input()
  const result = await publish(candidate)
  assert.equal(result.status, 'published')
  const active = await snapshot()
  assert.equal(active.pointer, `catalogs/${result.catalogSha256}`)
  assert.equal(sha256(active.catalog), result.catalogSha256)
  assert.ok(verify(null, Buffer.from(active.catalog), pair.publicKey, Buffer.from(active.signature.trim(), 'base64')))
  const artifact = join(state, 'artifacts', candidate.item.id, candidate.item.version, candidate.filename)
  assert.deepEqual(await readFile(artifact), candidate.content)
  assert.ok(!(await readdir(state)).some(name => name.startsWith('.publish-') || name.startsWith('.current-')))
  assert.deepEqual(await publish(candidate), result)
  assert.deepEqual(await snapshot(), active)
}))

test('an unrelated signing key and modified catalog bytes cannot replace the active pointer', serverOnly, async () => fixture(async ({ input, publish, snapshot }) => {
  await publish(await input())
  const active = await snapshot()
  const candidate = await input('0.3.0')
  await candidate.seal(generateKeyPairSync('ed25519').privateKey)
  await publish(candidate, /signature verification failed/)
  assert.deepEqual(await snapshot(), active)
  await candidate.seal()
  await writeFile(join(candidate.directory, 'catalog.json'), `${JSON.stringify(candidate.catalog)} `)
  await publish(candidate, /signature verification failed/)
  assert.deepEqual(await snapshot(), active)
}))

test('corrupt artifact bytes never become public and preserve the previous current pointer', serverOnly, async () => fixture(async ({ state, input, publish, snapshot }) => {
  await publish(await input())
  const active = await snapshot()
  const candidate = await input('0.3.0')
  await writeFile(join(candidate.directory, candidate.filename), Buffer.alloc(candidate.content.length, 65))
  await publish(candidate, /artifact differs from signed metadata/)
  await assert.rejects(readFile(join(state, 'artifacts', 'notes', '0.3.0', candidate.filename)), { code: 'ENOENT' })
  assert.deepEqual(await snapshot(), active)
  assert.ok(!(await readdir(state)).some(name => name.startsWith('.publish-')))
}))

test('lower versions and stale catalog generations cannot replace the active catalog', serverOnly, async () => fixture(async ({ input, publish, snapshot }) => {
  await publish(await input('1.10.0'))
  const active = await snapshot()
  await publish(await input('1.9.9', { generatedAt: '2026-09-15T04:00:00Z' }), /downgrade/)
  assert.deepEqual(await snapshot(), active)
  await publish(await input('1.11.0', { generatedAt: '2026-09-14T04:00:00Z' }), /roll back its generation/)
  assert.deepEqual(await snapshot(), active)
}))

test('an existing component version cannot acquire different signed bytes or activation metadata', serverOnly, async () => fixture(async ({ input, publish, snapshot }) => {
  const original = await input()
  await publish(original)
  const active = await snapshot()
  await publish(await input('0.2.0', { content: 'different authenticated bytes' }), /Immutable component metadata/)
  assert.deepEqual(await snapshot(), active)
  const candidate = await input()
  candidate.item.activation = 'restart'
  await candidate.seal()
  await publish(candidate, /Immutable component metadata/)
  assert.deepEqual(await snapshot(), active)
}))

test('an occupied artifact path with different bytes is never overwritten', serverOnly, async () => fixture(async ({ state, input, publish, snapshot }) => {
  await publish(await input())
  const active = await snapshot()
  const candidate = await input('0.3.0')
  const target = join(state, 'artifacts', 'notes', '0.3.0', candidate.filename)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, 'occupied')
  await publish(candidate, /Immutable publication/)
  assert.equal(await readFile(target, 'utf8'), 'occupied')
  assert.deepEqual(await snapshot(), active)
}))

test('standalone installer bytes require their own Ed25519 signature', serverOnly, async () => fixture(async ({ state, input, publish, snapshot }) => {
  const candidate = await input('0.1.0', { id: 'updates' })
  await publish(candidate)
  const active = await snapshot()
  const next = await input('0.2.0', { id: 'updates' })
  await writeFile(join(next.directory, 'install-updates-0.2.0.mjs'), 'untrusted code')
  await publish(next, /signature verification failed/)
  assert.deepEqual(await snapshot(), active)
  await assert.rejects(readFile(join(state, 'installers', 'install-updates-0.2.0.mjs')), { code: 'ENOENT' })
}))

test('a valid installer signature cannot be renamed into another version', serverOnly, async () => fixture(async ({ state, input, publish, snapshot }) => {
  const initial = await input('0.1.0', { id: 'updates' })
  await publish(initial)
  const active = await snapshot()
  const candidate = await input('0.2.0', { id: 'updates' })
  await copyFile(join(initial.directory, 'install-updates-0.1.0.mjs'), join(candidate.directory, 'install-updates-0.2.0.mjs'))
  await copyFile(join(initial.directory, 'install-updates-0.1.0.mjs.sig'), join(candidate.directory, 'install-updates-0.2.0.mjs.sig'))
  await publish(candidate, /signature verification failed/)
  assert.deepEqual(await snapshot(), active)
  await assert.rejects(readFile(join(state, 'installers', 'install-updates-0.2.0.mjs')), { code: 'ENOENT' })
}))

test('publication refuses linked output directories without writing through them', serverOnly, async () => fixture(async ({ root, state, input, publish }) => {
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(state, 'artifacts'))
  await publish(await input(), /directories must not be symbolic links/)
  assert.deepEqual(await readdir(outside), [])
  await assert.rejects(readlink(join(state, 'current')), { code: 'ENOENT' })
}))

test('the signing CLI rejects a key different from the package public key without changing its output', async () => fixture(async ({ root, privatePath, input }) => {
  const candidate = await input()
  const before = await readFile(join(candidate.directory, 'catalog.json.sig'))
  await assert.rejects(execute(process.execPath, [signer, '--key', privatePath, '--catalog', join(candidate.directory, 'catalog.json')], { env, timeout: 30_000, maxBuffer: 128 * 1024 }), error => {
    assert.equal(error.killed, false)
    assert.equal(error.signal, null)
    assert.equal(error.code, 1)
    assert.match(error.stderr, /does not match the pinned component key/)
    return true
  })
  assert.deepEqual(await readFile(join(candidate.directory, 'catalog.json.sig')), before)
  assert.ok((await readdir(root)).includes(basename(privatePath)))
}))

test('the isolated signing CLI binds the finite utility to its archived bytes before signing either output', serverOnly, async () => fixture(async ({ root, pair, publicPath, privatePath, input }) => {
  const project = join(root, 'signer-project')
  await mkdir(join(project, 'scripts'), { recursive: true })
  await mkdir(join(project, 'dist'))
  await writeFile(join(project, 'package.json'), '{"type":"module"}')
  await copyFile(signer, join(project, 'scripts/sign-catalog.mjs'))
  await copyFile(fileURLToPath(new URL('../dist/index.js', import.meta.url)), join(project, 'dist/index.js'))
  await copyFile(publicPath, join(project, 'component-signing.pub'))
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(project, 'node_modules'))
  const candidate = await input('0.1.0', { id: 'updates' })
  const utilityPath = join(candidate.directory, 'install-updates-0.1.0.mjs')
  const utility = await readFile(utilityPath)
  const source = join(root, 'archive-source')
  await mkdir(join(source, 'package/dist'), { recursive: true })
  await writeFile(join(source, 'package/dist/install.mjs'), utility)
  const archivePath = join(candidate.directory, candidate.filename)
  await createTar({ cwd: source, file: archivePath, gzip: true }, ['package'])
  const archive = await readFile(archivePath)
  candidate.item.size = archive.length
  candidate.item.sha256 = sha256(archive)
  await candidate.seal()
  const args = [join(project, 'scripts/sign-catalog.mjs'), '--key', privatePath, '--catalog', join(candidate.directory, 'catalog.json')]
  await execute(process.execPath, args, { env, timeout: 30_000, maxBuffer: 128 * 1024 })
  const catalogSignature = await readFile(join(candidate.directory, 'catalog.json.sig'))
  const utilitySignature = await readFile(`${utilityPath}.sig`)
  assert.ok(verify(null, Buffer.concat([Buffer.from('clawmaster-installer\0install-updates-0.1.0.mjs\0'), utility]), pair.publicKey, Buffer.from(utilitySignature.toString().trim(), 'base64')))
  await writeFile(utilityPath, 'substituted standalone installer')
  await assert.rejects(execute(process.execPath, args, { env, timeout: 30_000, maxBuffer: 128 * 1024 }), error => {
    assert.equal(error.killed, false)
    assert.equal(error.signal, null)
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Standalone installer differs from the authenticated package/)
    return true
  })
  assert.deepEqual(await readFile(join(candidate.directory, 'catalog.json.sig')), catalogSignature)
  assert.deepEqual(await readFile(`${utilityPath}.sig`), utilitySignature)
}))
