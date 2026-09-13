/** Artifact integrity rejects relocated, modified or incomplete Linux native payloads. */
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { PAYLOAD_PROVENANCE_PATH } from './build-provenance.mjs'
import { hashBundledContent } from './bundle-harness-source.mjs'
import { verifyLinuxPackage } from './verify-linux-package.mjs'

function fixture(t, { omitMusl = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'linux-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prepared = join(root, 'prepared')
  const packageRoot = join(root, 'extracted')
  const payload = join(packageRoot, 'usr/share/ClawMaster/harness-source')
  const native = 'native/system/packages/linux-x64/bin'
  for (const name of ['glibc/system.node', 'musl/system.node', 'landlock-run']) {
    if (omitMusl && name === 'musl/system.node') continue
    const path = join(prepared, native, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]))
  }
  chmodSync(join(prepared, native, 'landlock-run'), 0o755)
  const buildProvenance = { schemaVersion: 1, mode: 'release', buildId: 'synthetic', source: { dirty: false } }
  writeFileSync(join(prepared, PAYLOAD_PROVENANCE_PATH), JSON.stringify(buildProvenance))
  writeFileSync(join(prepared, '.bundle-manifest.json'), JSON.stringify({
    buildProvenance, contentSha256: hashBundledContent(prepared),
  }))
  cpSync(prepared, payload, { recursive: true })
  return { prepared, packageRoot, payload, native }
}

test('Linux extraction retains the exact payload and all native variants', t => {
  const { prepared, packageRoot, payload } = fixture(t)
  assert.equal(verifyLinuxPackage(packageRoot, prepared, 'x64'), payload)
})

test('Linux verification rejects an ELF changed during bundling', t => {
  const { prepared, packageRoot, payload, native } = fixture(t)
  writeFileSync(join(payload, native, 'glibc/system.node'), 'modified RPATH')
  assert.throws(() => verifyLinuxPackage(packageRoot, prepared, 'x64'), /digest does not match/)
})

test('Linux verification rejects a native variant omitted from both source and package', t => {
  const { prepared, packageRoot } = fixture(t, { omitMusl: true })
  assert.throws(() => verifyLinuxPackage(packageRoot, prepared, 'x64'), /ENOENT/)
})

test('Linux verification rejects a runtime duplicated under usr/lib', t => {
  const { prepared, packageRoot } = fixture(t)
  mkdirSync(join(packageRoot, 'usr/lib/ClawMaster/harness-source'), { recursive: true })
  assert.throws(() => verifyLinuxPackage(packageRoot, prepared, 'x64'), /usr\/lib ELF scan/)
})

test('Linux verification rejects a sandbox launcher without executable permissions', t => {
  const { prepared, packageRoot, payload, native } = fixture(t)
  chmodSync(join(payload, native, 'landlock-run'), 0o644)
  assert.throws(() => verifyLinuxPackage(packageRoot, prepared, 'x64'), /must remain executable/)
})
