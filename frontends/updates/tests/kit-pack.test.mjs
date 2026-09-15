import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildKit } from '../scripts/build-kit.mjs'
import { packKit, parseOptions } from '../scripts/pack-kit.mjs'

const run = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const wasmName = '@threema/wasm-minisign-verify'
const archiveName = 'clawmaster-dsh-updates-0.1.0.tgz'

async function fixture(t) {
  const repository = await mkdtemp(join(tmpdir(), 'clawmaster-kit-pack-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  await run('git', ['init', '--quiet', repository])
  await writeFile(join(repository, '.gitignore'), 'artifacts/\n')
  const root = join(repository, 'frontends', 'updates')
  const payloadDir = join(root, 'artifacts', 'published')
  const outputDir = join(root, 'artifacts', 'kit')
  const wasm = join(root, 'node_modules', wasmName)
  for (const directory of ['src', 'kit/dist', 'kit/guide', 'dist']) await mkdir(join(root, directory), { recursive: true })
  await mkdir(payloadDir, { recursive: true })
  await mkdir(wasm, { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const signingKeyPath = join(repository, 'private-test-key.pem')
  await writeFile(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(join(root, 'src/keys.ts'), `export const COMPONENT_PUBLIC_KEY = ${JSON.stringify(pem)};\n`)
  await writeFile(join(root, 'src/update-kit.ts'), 'import { basename } from "node:path"; export const name: string = basename("kit/fixture");\n')
  await writeFile(join(root, 'dist/index.js'), 'published artifact must remain unchanged\n')
  for (const name of ['README.md', 'README.zh.md', 'guide/README.md', 'guide/README.zh.md']) await writeFile(join(root, 'kit', name), `${name}\nfixture documentation\n`)
  await writeFile(join(root, 'kit/README.i18n.yaml'), 'must not ship\n')
  await writeFile(join(root, 'kit/GUIDE.md'), 'obsolete guide must not ship\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { [wasmName]: '0.2.0-rc.1' } }))
  await writeFile(join(wasm, 'package.json'), JSON.stringify({ name: wasmName, version: '0.2.0-rc.1' }))
  for (const name of ['README.md', 'wasm_minisign_verify.js', 'wasm_minisign_verify_bg.wasm', 'wasm_minisign_verify.d.ts']) await writeFile(join(wasm, name), `${name}\n`)
  await writeFile(join(wasm, '.env'), 'private dependency-local residue must not ship\n')
  const archive = Buffer.from('original published archive bytes')
  const catalog = { schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [{ id: 'updates', packageName: '@clawmaster/dsh-updates', kind: 'component', activation: 'restart', entry: './dist/index.js', version: '0.1.0', requiresDshVersion: '0.1.5-rc.2', url: `https://8.140.52.117/updates/clawmaster/components/artifacts/updates/0.1.0/${archiveName}`, sha256: digest(archive), size: archive.length }] }
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog)}\n`)
  await writeFile(join(payloadDir, 'catalog.json'), catalogBytes)
  await writeFile(join(payloadDir, 'catalog.json.sig'), `${sign(null, catalogBytes, privateKey).toString('base64')}\n`)
  await writeFile(join(payloadDir, archiveName), archive)
  await buildKit({ root })
  return { repository, root, wasm, archive, publicKey, privateKey, catalogBytes,
    options: { publishedPayloadDir: payloadDir, signingKeyPath, sourceCommit: 'a'.repeat(40), outputDir } }
}

async function inspectZip(path) {
  const program = `import base64,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 print(json.dumps([{ 'name':entry.filename, 'time':list(entry.date_time), 'mode':entry.external_attr >> 16, 'body':base64.b64encode(archive.read(entry)).decode() } for entry in archive.infolist()]))`
  return JSON.parse((await run('python3', ['-I', '-c', program, path], { maxBuffer: 16 * 1024 * 1024 })).stdout)
}

test('kit build is separate from published dist and check mode rejects stale output', async t => {
  const f = await fixture(t)
  const before = await readFile(join(f.root, 'dist/index.js'))
  const built = await buildKit({ root: f.root, check: true })
  assert.equal(built.path, join(f.root, 'kit/dist/update-kit.mjs'))
  assert.match(await readFile(built.path, 'utf8'), /createRequire/)
  await writeFile(built.path, 'stale')
  await assert.rejects(buildKit({ root: f.root, check: true }), /Stale update kit artifact/)
  await buildKit({ root: f.root })
  assert.deepEqual(await readFile(join(f.root, 'dist/index.js')), before)
})

test('signed kit preserves published bytes, excludes secrets and metadata, and produces reproducible ZIP and delivery signatures', async t => {
  const f = await fixture(t)
  const first = await packKit(f.options, f.root)
  const zip = await inspectZip(first.archive)
  const names = zip.map(entry => entry.name)
  assert.deepEqual(names, [...names].sort())
  assert.ok(names.every(name => name.startsWith('ClawMaster-Update-Kit/')))
  assert.ok(names.every(name => !/private-test-key|\.env|\.i18n|kit\/dist|GUIDE\.md/u.test(name)))
  assert.ok(names.includes('ClawMaster-Update-Kit/guide/README.zh.md'))
  for (const entry of zip) { assert.deepEqual(entry.time, [1980, 1, 1, 0, 0, 0]); assert.equal(entry.mode, 0o100644) }
  const files = new Map(zip.map(entry => [entry.name.replace('ClawMaster-Update-Kit/', ''), Buffer.from(entry.body, 'base64')]))
  assert.deepEqual(files.get(`payloads/${archiveName}`), f.archive)
  assert.deepEqual(files.get('payloads/catalog.json'), f.catalogBytes)
  const manifestBytes = files.get('kit-manifest.json')
  const manifest = JSON.parse(manifestBytes)
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'kitVersion', 'sourceCommit', 'files'])
  assert.equal(manifest.sourceCommit, f.options.sourceCommit)
  assert.ok(verify(null, manifestBytes, f.publicKey, Buffer.from(files.get('kit-manifest.json.sig').toString().trim(), 'base64')))
  for (const entry of manifest.files) { assert.equal(digest(files.get(entry.path)), entry.sha256); assert.equal(files.get(entry.path).length, entry.size) }
  assert.equal(manifest.files.length, files.size - 2)
  const deliveryBytes = await readFile(first.deliveryManifest)
  const delivery = JSON.parse(deliveryBytes)
  assert.deepEqual(Object.keys(delivery), ['schemaVersion', 'kitVersion', 'sourceCommit', 'filename', 'url', 'sha256', 'size'])
  assert.equal(delivery.sha256, digest(await readFile(first.archive)))
  assert.equal(delivery.size, (await readFile(first.archive)).length)
  assert.equal(delivery.url, 'https://8.140.52.117/updates/clawmaster/kits/0.1.0/clawmaster-update-kit-0.1.0.zip')
  assert.ok(verify(null, deliveryBytes, f.publicKey, Buffer.from((await readFile(first.deliverySignature, 'utf8')).trim(), 'base64')))
  assert.deepEqual(await packKit(f.options, f.root), first)
  assert.deepEqual((await readdir(f.options.outputDir)).sort(), ['SHA256SUMS.txt', 'clawmaster-update-kit-0.1.0.zip', 'delivery.json', 'delivery.json.sig'])
})

test('catalog tampering, changed archive bytes and mismatched signing keys fail before output publication', async t => {
  for (const change of ['catalog', 'archive', 'key']) {
    const f = await fixture(t)
    if (change === 'catalog') await writeFile(join(f.options.publishedPayloadDir, 'catalog.json'), Buffer.concat([f.catalogBytes, Buffer.from(' ')]))
    if (change === 'archive') await writeFile(join(f.options.publishedPayloadDir, archiveName), 'tampered')
    if (change === 'key') await writeFile(f.options.signingKeyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await assert.rejects(packKit(f.options, f.root), /signature verification|archive differs|does not match/)
    await assert.rejects(readFile(f.options.outputDir), { code: 'ENOENT' })
  }
})

test('nonignored output, unsafe input links and immutable output changes fail closed', async t => {
  const f = await fixture(t)
  await assert.rejects(packKit({ ...f.options, outputDir: join(f.root, 'public') }, f.root), /ignored artifacts/)
  const first = await packKit(f.options, f.root)
  const bytes = await readFile(first.archive)
  await writeFile(join(f.root, 'kit/README.md'), 'changed documentation')
  await assert.rejects(packKit(f.options, f.root), /Immutable kit delivery/)
  assert.deepEqual(await readFile(first.archive), bytes)
  assert.ok((await readdir(f.options.outputDir)).every(name => !name.startsWith('.kit-stage-')))
  const payload = join(f.options.publishedPayloadDir, archiveName)
  await rm(payload)
  await symlink(join(f.root, 'kit/README.md'), payload)
  await assert.rejects(packKit(f.options, f.root), /bounded regular/)
})

test('CLI parser requires every explicit option and rejects unknown or repeated flags', async () => {
  const valid = ['--published-payload-dir', '/tmp/published', '--signing-key', '/tmp/key', '--source-commit', 'a'.repeat(40), '--output-dir', '/tmp/artifacts']
  assert.equal(parseOptions(valid).sourceCommit, 'a'.repeat(40))
  for (const args of [[], valid.slice(0, -2), [...valid, '--unknown', 'value'], [...valid, '--output-dir', '/tmp/again'], valid.map(value => value === '/tmp/key' ? 'relative' : value), valid.map(value => value === 'a'.repeat(40) ? 'main' : value)]) assert.throws(() => parseOptions(args))
  await assert.rejects(run(process.execPath, [new URL('../scripts/pack-kit.mjs', import.meta.url).pathname]), error => error.code === 1 && /absolute normalized path/.test(error.stderr))
  await assert.rejects(run(process.execPath, [new URL('../scripts/build-kit.mjs', import.meta.url).pathname, '--unknown']), error => error.code === 1 && /Usage/.test(error.stderr))
})
