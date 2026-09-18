/** Publish one signed portable kit as an immutable directory; the caller owns the server publication lock. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function regular(path, limit) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Kit publication input is not a bounded regular file')
  const bytes = await readFile(path)
  if (bytes.length > limit) throw new Error('Kit publication input exceeds its byte limit')
  return bytes
}

/** Verify the delivery signature and exact ZIP bytes, then expose all files in one directory rename.
 * @param options Private inbox, dedicated publication root and installed public-key file.
 * @returns Published version and digest; identical repeats preserve the immutable directory.
 */
export async function publishKit(options) {
  for (const path of [options.inbox, options.root, options.publicKey]) if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error('Publication paths must be absolute and normalized')
  const bytes = await regular(join(options.inbox, 'delivery.json'), 64 * 1024)
  const signatureBytes = await regular(join(options.inbox, 'delivery.json.sig'), 1024)
  const encoded = signatureBytes.toString('utf8').trim()
  const signature = Buffer.from(encoded, 'base64')
  const key = createPublicKey(await regular(options.publicKey, 16 * 1024))
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || signature.toString('base64') !== encoded || !verify(null, bytes, key, signature)) throw new Error('Kit delivery signature verification failed')
  const delivery = JSON.parse(bytes.toString('utf8'))
  const fields = ['schemaVersion', 'kitVersion', 'sourceCommit', 'filename', 'url', 'sha256', 'size']
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery) || Object.keys(delivery).length !== fields.length || fields.some(field => !Object.hasOwn(delivery, field))
    || delivery.schemaVersion !== 1 || typeof delivery.kitVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(delivery.kitVersion)
    || typeof delivery.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(delivery.sourceCommit)
    || delivery.filename !== `clawmaster-update-kit-${delivery.kitVersion}.zip`
    || delivery.url !== `https://8.140.52.117/updates/clawmaster/kits/${delivery.kitVersion}/${delivery.filename}`
    || typeof delivery.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(delivery.sha256)
    || !Number.isSafeInteger(delivery.size) || delivery.size <= 0 || delivery.size > 128 * 1024 * 1024) throw new Error('Invalid kit delivery fields')
  const archive = await regular(join(options.inbox, delivery.filename), 128 * 1024 * 1024)
  if (archive.length !== delivery.size || digest(archive) !== delivery.sha256) throw new Error('Kit ZIP differs from its signed delivery')
  await mkdir(options.root, { recursive: true, mode: 0o755 })
  const rootInfo = await lstat(options.root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Kit publication root must be a real directory')
  const files = new Map([[delivery.filename, archive], ['delivery.json', bytes], ['delivery.json.sig', signatureBytes],
    ['SHA256SUMS.txt', Buffer.from(`${delivery.sha256}  ${delivery.filename}\n`)]])
  const destination = join(options.root, delivery.kitVersion)
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(destination)).length !== files.size) throw new Error('Immutable kit directory is redirected or has unexpected files')
    for (const [filename, contents] of files) if (!(await regular(join(destination, filename), 128 * 1024 * 1024)).equals(contents)) throw new Error('An immutable kit version already exists with different content')
    return { status: 'unchanged', version: delivery.kitVersion, sha256: delivery.sha256 }
  }
  const stage = await mkdtemp(join(options.root, '.publish-'))
  try {
    for (const [filename, contents] of files) await writeFile(join(stage, filename), contents, { flag: 'wx', mode: 0o644 })
    await chmod(stage, 0o755)
    await rename(stage, destination)
  } finally { await rm(stage, { recursive: true, force: true }) }
  return { status: 'published', version: delivery.kitVersion, sha256: delivery.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { inbox: { type: 'string' }, root: { type: 'string' }, 'public-key': { type: 'string' } } })
    console.log(JSON.stringify(await publishKit({ inbox: values.inbox, root: values.root, publicKey: values['public-key'] })))
  } catch (error) { console.error(error instanceof Error ? error.message : 'Kit publication failed'); process.exitCode = 1 }
}
