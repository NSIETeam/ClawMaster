/** Write SHA-256 checksums for every versioned release download. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = resolve(process.argv[2] ?? 'release-assets')
const entries = (await readdir(directory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== 'SHA256SUMS.txt')
  .map(entry => entry.name).sort()
if (entries.length === 0) throw new Error('Release asset directory is empty')
const lines = []
for (const name of entries) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(resolve(directory, name))) hash.update(bytes)
  lines.push(`${hash.digest('hex')}  ${name}`)
}
await writeFile(resolve(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
console.log(`Recorded SHA-256 checksums for ${entries.length} release downloads`)
