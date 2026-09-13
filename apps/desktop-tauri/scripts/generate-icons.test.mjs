/** Icon generation stays byte-reproducible: the ICNS container is written in a canonical order. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { normalizeIcns } from './generate-icons.mjs'

const desktop = resolve(import.meta.dirname, '..')
const committed = join(desktop, 'src-tauri/icons/icon.icns')
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

/** Build an ICNS container from the given `[type, payload]` entries, in that order. */
function container(entries) {
  const bodies = entries.map(([type, payload]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(8 + payload.length, 4)
    return Buffer.concat([head, payload])
  })
  const body = Buffer.concat(bodies)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'latin1')
  header.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([header, body])
}

/** Read an ICNS container back into its ordered `[type, payload]` entries. */
function entries(path) {
  const file = readFileSync(path)
  const parsed = []
  for (let offset = 8; offset + 8 <= file.length;) {
    const type = file.subarray(offset, offset + 4).toString('latin1')
    const size = file.readUInt32BE(offset + 4)
    parsed.push([type, file.subarray(offset + 8, offset + size)])
    offset += size
  }
  return parsed
}

test('normalizeIcns orders entries by type and keeps every payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-icns-'))
  try {
    const path = join(root, 'icon.icns')
    // Deliberately out of order, echoing what `tauri icon` emits run to run.
    const original = container([
      ['ic11', Buffer.concat([PNG, Buffer.from('small')])],
      ['ic10', Buffer.concat([PNG, Buffer.from('large')])],
      ['ic07', Buffer.concat([PNG, Buffer.from('medium')])],
    ])
    writeFileSync(path, original)

    assert.deepEqual(normalizeIcns(path), ['ic07', 'ic10', 'ic11'])

    const rewritten = readFileSync(path)
    assert.equal(rewritten.readUInt32BE(4), rewritten.length, 'the declared length must match the file')
    assert.equal(rewritten.subarray(0, 4).toString('latin1'), 'icns')
    assert.deepEqual(entries(path).map(([type]) => type), ['ic07', 'ic10', 'ic11'])
    // Same bytes overall: only the sequence changed.
    assert.equal(rewritten.length, original.length)
    assert.deepEqual(
      entries(path).map(([type, payload]) => [type, payload.toString('latin1')]).sort(),
      [['ic07', 'medium'], ['ic10', 'large'], ['ic11', 'small']]
        .map(([type, text]) => [type, Buffer.concat([PNG, Buffer.from(text)]).toString('latin1')]).sort(),
    )

    // Normalizing twice is a no-op, which is what makes repeated builds stable.
    const once = readFileSync(path)
    normalizeIcns(path)
    assert.deepEqual(readFileSync(path), once)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('normalizeIcns refuses a file that is not a well-formed ICNS container', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-icns-'))
  try {
    const notIcns = join(root, 'plain.png')
    writeFileSync(notIcns, PNG)
    assert.throws(() => normalizeIcns(notIcns), /Not an ICNS container/)

    const truncated = join(root, 'truncated.icns')
    const file = container([['ic07', Buffer.concat([PNG, Buffer.from('x')])]])
    file.writeUInt32BE(file.length + 64, 4)
    writeFileSync(truncated, file)
    assert.throws(() => normalizeIcns(truncated), /declares a different length/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the committed icon is already canonical and holds every macOS representation', () => {
  const parsed = entries(committed)
  const types = parsed.map(([type]) => type)
  assert.deepEqual(types, [...types].sort(), 'the committed ICNS must be written in canonical order so a rebuild leaves the tree clean')
  for (const required of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) {
    assert.ok(types.includes(required), `the committed ICNS is missing ${required}`)
  }
  // The `ic*` slots are PNG representations; the legacy `is32`/`il32` bitmaps and the
  // `s8mk`/`l8mk` masks are raw, so only the PNG slots carry a PNG signature.
  for (const [type, payload] of parsed) {
    if (type.startsWith('ic')) assert.deepEqual(payload.subarray(0, 8), PNG, `${type} must carry a PNG payload`)
    else assert.notDeepEqual(payload.subarray(0, 8), PNG, `${type} is raw bitmap or mask data, not PNG`)
  }
  // Idempotence is checked on a copy: a test must never rewrite a tracked artifact,
  // or a failure would silently repair it instead of reporting it.
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-icns-'))
  try {
    const copy = join(root, 'icon.icns')
    writeFileSync(copy, readFileSync(committed))
    const canonical = readFileSync(copy)
    normalizeIcns(copy)
    assert.deepEqual(readFileSync(copy), canonical, 'normalizing a canonical container must not change it')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
