/** Sign a deterministic portable kit while preserving the already published plugin archive bytes. */
import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { lstat, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseSignedCatalog } from '../dist/index.js'

const run = promisify(execFile)
const defaultRoot = fileURLToPath(new URL('..', import.meta.url))
const version = '0.1.0'
const folder = 'ClawMaster-Update-Kit'
const archiveName = `clawmaster-dsh-updates-${version}.tgz`
const zipName = `clawmaster-update-kit-${version}.zip`
const wasmName = '@threema/wasm-minisign-verify'
const catalogUrl = 'https://8.140.52.117/updates/clawmaster/components/catalog.json'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be an absolute normalized path`)
  return value
}

async function regular(path, maximum) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Kit inputs must be bounded regular files')
  const bytes = await readFile(path)
  if (bytes.length > maximum) throw new Error('Kit input exceeds its byte limit')
  return bytes
}

function publicAnchor(source) {
  const match = /^export const COMPONENT_PUBLIC_KEY = ("(?:[^"\\]|\\.)*");?$/mu.exec(source)
  if (!match) throw new Error('Source must declare the component public key as a JSON string literal')
  return JSON.parse(match[1])
}

function signingKey(bytes, publicKeyPem) {
  let key
  try { key = createPrivateKey(bytes) }
  catch { throw new Error('Signing key must be a usable Ed25519 private key') }
  const expected = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519' || expected.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(expected.export({ type: 'spki', format: 'der' }))) throw new Error('Signing key does not match the component public key in source')
  return key
}

const zipProgram = `
import os, pathlib, stat, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(root.rglob('*'), key=lambda item: item.relative_to(root).as_posix()):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Kit stage contains a non-regular file')
        name = path.relative_to(root).as_posix()
        entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
`

/** Parse the explicit paths and source identity required for a signed kit.
 * @param args Command-line arguments without Node or script names.
 * @returns Validated packer options; unknown, duplicate and missing flags fail closed.
 */
export function parseOptions(args) {
  const names = { '--published-payload-dir': 'publishedPayloadDir', '--signing-key': 'signingKeyPath', '--source-commit': 'sourceCommit', '--output-dir': 'outputDir' }
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const field = names[args[index]]
    if (!field || field in options || typeof args[index + 1] !== 'string' || args[index + 1].startsWith('--')) throw new Error('Usage: pack-kit.mjs --published-payload-dir <absolute> --signing-key <absolute> --source-commit <40hex> --output-dir <absolute>')
    options[field] = args[index + 1]
  }
  for (const field of ['publishedPayloadDir', 'signingKeyPath', 'outputDir']) absolute(options[field], field)
  if (typeof options.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(options.sourceCommit)) throw new Error('sourceCommit must contain 40 lowercase hexadecimal digits')
  return options
}

/** Assemble and sign the kit from verified published payloads and an independently built entry.
 * @param options Explicit original payload directory, private signing-key path, source commit and output directory.
 * @param root Selected updates source directory; the CLI always uses this script's owning package.
 * @returns Immutable archive path, SHA-256, byte count and number of signed manifest files.
 */
export async function packKit(options, root = defaultRoot) {
  options = parseOptions(['--published-payload-dir', options.publishedPayloadDir, '--signing-key', options.signingKeyPath,
    '--source-commit', options.sourceCommit, '--output-dir', options.outputDir])
  try { await run('git', ['check-ignore', '--quiet', '--', join(options.outputDir, zipName)], { cwd: root }) }
  catch { throw new Error('Kit output must be inside an ignored artifacts directory in the selected checkout') }
  const publicKeyPem = publicAnchor((await regular(join(root, 'src/keys.ts'), 16 * 1024)).toString('utf8'))
  const key = signingKey(await regular(options.signingKeyPath, 64 * 1024), publicKeyPem)
  const catalogBytes = await regular(join(options.publishedPayloadDir, 'catalog.json'), 1024 * 1024)
  const signatureBytes = await regular(join(options.publishedPayloadDir, 'catalog.json.sig'), 1024)
  const catalog = parseSignedCatalog(catalogBytes, signatureBytes.toString('utf8'), { catalogUrl, publicKeyPem, maxDownloadBytes: 64 * 1024 * 1024 })
  const item = catalog.components.find(item => item.id === 'updates')
  if (!item || item.kind !== 'component' || item.packageName !== '@clawmaster/dsh-updates' || item.version !== version
    || item.entry !== './dist/index.js' || item.activation !== 'restart' || !item.url.endsWith(`/${archiveName}`)) throw new Error('Published catalog must contain the original updater 0.1.0 archive')
  const archiveBytes = await regular(join(options.publishedPayloadDir, archiveName), 64 * 1024 * 1024)
  if (archiveBytes.length !== item.size || digest(archiveBytes) !== item.sha256) throw new Error('Published updater archive differs from its signed catalog')

  const files = new Map([
    ['update-kit.mjs', await regular(join(root, 'kit/dist/update-kit.mjs'), 16 * 1024 * 1024)],
    ['README.md', await regular(join(root, 'kit/README.md'), 1024 * 1024)],
    ['README.zh.md', await regular(join(root, 'kit/README.zh.md'), 1024 * 1024)],
    ['guide/README.md', await regular(join(root, 'kit/guide/README.md'), 1024 * 1024)],
    ['guide/README.zh.md', await regular(join(root, 'kit/guide/README.zh.md'), 1024 * 1024)],
    ['payloads/catalog.json', catalogBytes], ['payloads/catalog.json.sig', signatureBytes],
    [`payloads/${archiveName}`, archiveBytes],
  ])
  const dependencyRoot = join(root, 'node_modules', wasmName)
  const dependency = JSON.parse((await regular(join(dependencyRoot, 'package.json'), 1024 * 1024)).toString('utf8'))
  const packageManifest = JSON.parse((await regular(join(root, 'package.json'), 1024 * 1024)).toString('utf8'))
  if (dependency.name !== wasmName || dependency.version !== packageManifest.dependencies?.[wasmName]) throw new Error('WASM dependency does not match the pinned package version')
  // This pinned package ships exactly one JS module and its companion WASM file.
  for (const name of ['package.json', 'README.md', 'wasm_minisign_verify.js', 'wasm_minisign_verify_bg.wasm', 'wasm_minisign_verify.d.ts']) {
    files.set(`node_modules/${wasmName}/${name}`, await regular(join(dependencyRoot, name), 16 * 1024 * 1024))
  }
  const manifest = { schemaVersion: 1, kitVersion: version, sourceCommit: options.sourceCommit,
    files: [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, bytes]) => ({ path, sha256: digest(bytes), size: bytes.length })) }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const signature = sign(null, manifestBytes, key)
  if (!verify(null, manifestBytes, publicKeyPem, signature)) throw new Error('Generated kit signature did not verify')
  files.set('kit-manifest.json', manifestBytes)
  files.set('kit-manifest.json.sig', Buffer.from(`${signature.toString('base64')}\n`))

  await mkdir(options.outputDir, { recursive: true, mode: 0o700 })
  const directory = await lstat(options.outputDir)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Kit output directory must be a real directory')
  const stage = await mkdtemp(join(options.outputDir, '.kit-stage-'))
  try {
    const tree = join(stage, 'tree')
    for (const [name, bytes] of files) {
      const destination = join(tree, folder, name)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' })
    }
    const temporary = join(stage, zipName)
    await run('python3', ['-I', '-c', zipProgram, tree, temporary], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 })
    const bytes = await regular(temporary, 128 * 1024 * 1024)
    const delivery = { schemaVersion: 1, kitVersion: version, sourceCommit: options.sourceCommit,
      filename: zipName, url: `https://8.140.52.117/updates/clawmaster/kits/${version}/${zipName}`, sha256: digest(bytes), size: bytes.length }
    const deliveryBytes = Buffer.from(`${JSON.stringify(delivery, null, 2)}\n`)
    const deliverySignature = Buffer.from(`${sign(null, deliveryBytes, key).toString('base64')}\n`)
    const outputs = new Map([[zipName, bytes], ['delivery.json', deliveryBytes], ['delivery.json.sig', deliverySignature],
      ['SHA256SUMS.txt', Buffer.from(`${delivery.sha256}  ${zipName}\n`)]])
    for (const [name, value] of outputs) {
      try {
        if (digest(await regular(join(options.outputDir, name), 128 * 1024 * 1024)) !== digest(value)) throw new Error('Immutable kit delivery files already exist with different content')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (name !== zipName) await writeFile(join(stage, name), value, { flag: 'wx', mode: 0o600 })
    }
    for (const [name, value] of outputs) {
      const destination = join(options.outputDir, name)
      try { await link(join(stage, name), destination) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (digest(await regular(destination, 128 * 1024 * 1024)) !== digest(value)) throw new Error('Immutable kit delivery files changed during packaging')
      }
    }
    return { archive: join(options.outputDir, zipName), deliveryManifest: join(options.outputDir, 'delivery.json'),
      deliverySignature: join(options.outputDir, 'delivery.json.sig'), sha256: digest(bytes), size: bytes.length, files: manifest.files.length }
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await packKit(parseOptions(process.argv.slice(2))))) }
  catch (error) { console.error(error instanceof Error ? error.message : 'Update kit packaging failed'); process.exitCode = 1 }
}
