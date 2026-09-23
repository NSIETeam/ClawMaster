/** Copy reviewed release evidence without overwriting original build assets. */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { copyFile, lstat, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** @param {{source:string,destination:string}} options Flat evidence directory and original build-asset directory. @returns {Promise<string[]>} Copied evidence file names. */
export async function copyReleaseEvidence({ source, destination }) {
  const sourceRoot = resolve(source)
  const destinationRoot = resolve(destination)
  const sourceInfo = await lstat(sourceRoot)
  assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), 'Acceptance evidence must be a real directory')
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  assert.ok(entries.length > 0, 'Acceptance evidence directory is empty')
  const files = []
  for (const entry of entries) {
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Acceptance evidence must contain regular files only: ${entry.name}`)
    assert.equal(basename(entry.name), entry.name, 'Acceptance evidence filenames must be basenames')
    assert.notEqual(entry.name, 'SHA256SUMS.txt', 'Release checksums are generated after evidence is added')
    const target = join(destinationRoot, entry.name)
    await assert.rejects(lstat(target), { code: 'ENOENT' }, `Acceptance evidence cannot replace an original build asset: ${entry.name}`)
    await copyFile(join(sourceRoot, entry.name), target, 0x1)
    files.push(entry.name)
  }
  assert.ok(files.includes('acceptance-manifest.json'), 'Acceptance ref must include acceptance-manifest.json')
  return files.sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, destination: { type: 'string' } } })
  assert.ok(values.source && values.destination, 'Required: --source <flat evidence dir> --destination <original assets dir>')
  console.log(`Copied ${ (await copyReleaseEvidence({ source: values.source, destination: values.destination })).length } reviewed evidence files`)
}
