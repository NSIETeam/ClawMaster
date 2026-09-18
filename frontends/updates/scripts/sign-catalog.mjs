/** Sign the exact catalog bytes with the offline component key after artifact verification. */
import { createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Parser } from 'tar'
import { parseSignedCatalog } from '../dist/index.js'

const { values } = parseArgs({ options: { key: { type: 'string' }, catalog: { type: 'string' } } })
if (!values.key || !values.catalog) throw new Error('Specify --key <private-key-path> and --catalog <catalog.json>')
const privateKey = createPrivateKey(await readFile(resolve(values.key)))
const publicKeyPem = await readFile(new URL('../component-signing.pub', import.meta.url), 'utf8')
const expectedKey = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
if (!createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(expectedKey)) throw new Error('Signing key does not match the pinned component key')
const catalogPath = resolve(values.catalog)
const bytes = await readFile(catalogPath)
const signature = sign(null, bytes, privateKey).toString('base64')
const catalog = parseSignedCatalog(bytes, signature, { catalogUrl: 'https://8.140.52.117/updates/clawmaster/components/catalog.json', publicKeyPem, maxDownloadBytes: 2 * 1024 * 1024 * 1024 })
const installerSignatures = []
for (const item of catalog.components) {
  const artifact = await readFile(join(dirname(catalogPath), basename(new URL(item.url).pathname)))
  if (artifact.length !== item.size || createHash('sha256').update(artifact).digest('hex') !== item.sha256) throw new Error('Catalog artifact differs from its declared size or hash')
  if (item.id === 'updates') {
    const path = join(dirname(catalogPath), `install-updates-${item.version}.mjs`)
    const utility = await readFile(path)
    const chunks = []
    let matches = 0
    let total = 0
    const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 })
    parser.on('entry', entry => {
      total += entry.size
      if (total > 256 * 1024 * 1024) { parser.abort(new Error('Signing archive exceeds the expanded byte limit')); return }
      if (entry.path === 'package/dist/install.mjs') {
        matches += 1
        if (entry.type !== 'File' || entry.size > 8 * 1024 * 1024) { parser.abort(new Error('Invalid packaged installer')); return }
        entry.on('data', chunk => chunks.push(chunk))
      }
      entry.resume()
    })
    await pipeline(Readable.from([artifact]), parser)
    if (matches !== 1 || !Buffer.concat(chunks).equals(utility)) throw new Error('Standalone installer differs from the authenticated package')
    const signedUtility = Buffer.concat([Buffer.from(`clawmaster-installer\0${basename(path)}\0`), utility])
    installerSignatures.push([`${path}.sig`, `${sign(null, signedUtility, privateKey).toString('base64')}\n`])
  }
}
for (const [path, signature] of installerSignatures) await writeFile(path, signature)
await writeFile(`${catalogPath}.sig`, `${signature}\n`)
console.log('Signed catalog matches the pinned public key and local artifacts.')
