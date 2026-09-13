/** Generate desktop icon formats from the shared ClawMaster vector artwork. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(desktop, '../../frontends/dsh/src/clawmaster.svg')
const require = createRequire(import.meta.url)
const formats = ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns']

/**
 * Rewrite an ICNS container with its entries in a canonical order.
 *
 * Entry ordering preserves encoded images and makes repeated Tauri icon generation byte-stable.
 *
 * @param path - ICNS file to rewrite in place.
 * @returns The entry types in their canonical order.
 */
export function normalizeIcns(path) {
  const container = readFileSync(path)
  if (container.length < 8 || container.subarray(0, 4).toString('latin1') !== 'icns') throw new Error(`Not an ICNS container: ${path}`)
  if (container.readUInt32BE(4) !== container.length) throw new Error(`ICNS declares a different length: ${path}`)

  const entries = []
  for (let offset = 8; offset < container.length;) {
    if (container.length - offset < 8) throw new Error(`Incomplete ICNS entry header: ${path}`)
    const type = container.subarray(offset, offset + 4).toString('latin1')
    const size = container.readUInt32BE(offset + 4)
    if (size < 8 || offset + size > container.length) throw new Error(`Invalid ICNS entry ${type} in ${path}`)
    entries.push(container.subarray(offset, offset + size))
    offset += size
  }
  if (entries.length === 0) throw new Error(`ICNS holds no entries: ${path}`)

  const ordered = entries
    .map(entry => ({ entry, type: entry.subarray(0, 4).toString('latin1') }))
    .sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0))
  const body = Buffer.concat(ordered.map(entry => entry.entry))
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'latin1')
  header.writeUInt32BE(8 + body.length, 4)
  writeFileSync(path, Buffer.concat([header, body]))
  return ordered.map(entry => entry.type)
}

function main() {
  const output = mkdtempSync(join(tmpdir(), 'clawmaster-vector-icons-'))
  try {
    execFileSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'icon', source, '--output', output], {
      cwd: desktop, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const targets = formats.map(name => [join(output, name), join(desktop, 'src-tauri/icons', name)])
    targets.push([join(output, 'icon.png'), join(desktop, 'app-icon.png')])
    for (const [generated, target] of targets) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(generated, target)
      if (target.endsWith('icon.icns')) normalizeIcns(target)
    }
    console.log('ClawMaster vector icons generated.')
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
