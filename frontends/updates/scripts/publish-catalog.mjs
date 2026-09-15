/** Publish authenticated immutable files, then switch the catalog; the caller owns the publication lock. */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { input: { type: 'string' }, state: { type: 'string' }, 'public-key': { type: 'string' } } })
for (const key of ['input', 'state', 'public-key']) if (!values[key] || !isAbsolute(values[key]) || resolve(values[key]) !== values[key]) throw new Error(`Specify absolute --${key}`)
const digest = value => createHash('sha256').update(value).digest('hex')
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const fullVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const publicKey = createPublicKey(await readFile(values['public-key']))
if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Component publication requires an Ed25519 public key')

async function boundedFile(path, maximum) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Publication input must be a bounded regular file')
  const bytes = await readFile(path)
  if (bytes.length > maximum) throw new Error('Publication input exceeds its byte limit')
  return bytes
}

function authenticate(bytes, signature) {
  const encoded = signature.toString('utf8').trim()
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== encoded || !verify(null, bytes, publicKey, decoded)) throw new Error('Component signature verification failed')
}

function parseCatalog(bytes, signature) {
  authenticate(bytes, signature)
  const catalog = JSON.parse(bytes)
  if (catalog.schemaVersion !== 1 || typeof catalog.generatedAt !== 'string' || !Number.isFinite(Date.parse(catalog.generatedAt))
    || !Array.isArray(catalog.components) || catalog.components.length === 0) throw new Error('Invalid component catalog')
  const seen = new Set()
  for (const item of catalog.components) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.id) || !stable.test(item.version) || seen.has(item.id)
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(item.packageName)
      || !fullVersion.test(item.requiresDshVersion) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 2 * 1024 * 1024 * 1024
      || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error('Invalid component identity or artifact metadata')
    if (item.kind === 'component' ? item.entry !== './dist/index.js' || !['hot', 'restart'].includes(item.activation)
      : item.kind !== 'runtime' || item.activation !== 'desktop-required' || Object.hasOwn(item, 'entry')) throw new Error('Invalid component activation metadata')
    if (item.id === 'updates' && (item.kind !== 'component' || item.activation !== 'restart' || item.packageName !== '@clawmaster/dsh-updates')) throw new Error('Invalid updater component')
    seen.add(item.id)
    const url = new URL(item.url)
    const filename = basename(url.pathname)
    if (url.origin !== 'https://8.140.52.117' || url.username || url.password || url.search || url.hash
      || !/^[a-z0-9.-]+\.(?:tgz|tar\.gz)$/u.test(filename)
      || url.pathname !== `/updates/clawmaster/components/artifacts/${item.id}/${item.version}/${filename}`) throw new Error('Invalid component publication URL')
  }
  return catalog
}

async function secureDirectory(path) {
  if (path !== values.state) await secureDirectory(dirname(path))
  try { await mkdir(path, { mode: 0o755 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Publication directories must not be symbolic links')
}

function compareVersions(first, second) {
  const left = first.split('.').map(BigInt)
  const right = second.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  return 0
}

async function currentCatalog() {
  const current = join(values.state, 'current')
  let target
  try { target = await readlink(current) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!/^catalogs\/[a-f0-9]{64}$/u.test(target)) throw new Error('Current catalog pointer is outside the managed catalog directory')
  const directory = join(values.state, target)
  for (const path of [values.state, join(values.state, 'catalogs'), directory]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Current catalog directories must not be symbolic links')
  }
  const bytes = await boundedFile(join(directory, 'catalog.json'), 2 * 1024 * 1024)
  if (digest(bytes) !== basename(target)) throw new Error('Current catalog differs from its immutable generation')
  return parseCatalog(bytes, await boundedFile(join(directory, 'catalog.json.sig'), 1024))
}

const bytes = await boundedFile(join(values.input, 'catalog.json'), 2 * 1024 * 1024)
const signature = await boundedFile(join(values.input, 'catalog.json.sig'), 1024)
const catalog = parseCatalog(bytes, signature)
const previous = await currentCatalog()
if (previous) {
  if (Date.parse(catalog.generatedAt) < Date.parse(previous.generatedAt)) throw new Error('Catalog publication would roll back its generation')
  for (const old of previous.components) {
    const candidate = catalog.components.find(item => item.id === old.id)
    if (!candidate || compareVersions(candidate.version, old.version) < 0) throw new Error('Catalog publication would downgrade or remove a component')
    if (candidate.version === old.version && [...new Set([...Object.keys(old), ...Object.keys(candidate)])].some(key => old[key] !== candidate[key])) throw new Error('Immutable component metadata already exists with different values')
  }
}

const generation = digest(bytes)
const copies = []
for (const item of catalog.components) {
  const filename = basename(new URL(item.url).pathname)
  copies.push({ source: join(values.input, filename), target: join(values.state, 'artifacts', item.id, item.version, filename), size: item.size, sha256: item.sha256 })
  if (item.id === 'updates') {
    const utility = `install-updates-${item.version}.mjs`
    const content = await boundedFile(join(values.input, utility), 8 * 1024 * 1024)
    const proof = await boundedFile(join(values.input, `${utility}.sig`), 1024)
    authenticate(Buffer.concat([Buffer.from(`clawmaster-installer\0${utility}\0`), content]), proof)
    copies.push({ bytes: content, target: join(values.state, 'installers', utility) }, { bytes: proof, target: join(values.state, 'installers', `${utility}.sig`) })
  }
}
copies.push({ bytes, target: join(values.state, 'catalogs', generation, 'catalog.json') }, { bytes: signature, target: join(values.state, 'catalogs', generation, 'catalog.json.sig') })

await secureDirectory(values.state)
const staging = await mkdtemp(join(values.state, '.publish-'))
const temporary = join(values.state, `.current-${randomUUID()}`)
try {
  for (const [index, item] of copies.entries()) {
    item.staged = join(staging, String(index))
    if (item.bytes) {
      await writeFile(item.staged, item.bytes, { flag: 'wx', mode: 0o600 })
      item.size = item.bytes.length
      item.sha256 = digest(item.bytes)
    } else {
      const info = await lstat(item.source)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== item.size) throw new Error('Component artifact differs from signed metadata')
      const hash = createHash('sha256')
      let received = 0
      await pipeline(createReadStream(item.source), new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length
        hash.update(chunk)
        done(received > item.size ? new Error('Component artifact exceeds signed size') : null, chunk)
      } }), createWriteStream(item.staged, { flags: 'wx', mode: 0o600 }))
      if (received !== item.size || hash.digest('hex') !== item.sha256) throw new Error('Component artifact differs from signed metadata')
    }
    await chmod(item.staged, 0o644)
    await secureDirectory(dirname(item.target))
    try {
      const current = await boundedFile(item.target, item.size)
      if (current.length !== item.size || digest(current) !== item.sha256) throw new Error('Immutable publication already exists with different bytes')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const item of copies) {
    // Linking the completed inode publishes a whole file and refuses to replace an existing path.
    try { await link(item.staged, item.target) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  await symlink(`catalogs/${generation}`, temporary)
  await rename(temporary, join(values.state, 'current'))
  console.log(JSON.stringify({ status: 'published', catalogSha256: generation, components: catalog.components.map(({ id, version }) => ({ id, version })) }))
} finally {
  await rm(temporary, { force: true })
  await rm(staging, { recursive: true, force: true })
}
