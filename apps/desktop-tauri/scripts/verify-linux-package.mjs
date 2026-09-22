/** Verify the immutable runtime inside an extracted Linux installation artifact before provisioning. */
import assert from 'node:assert/strict'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { assertPreparedBundle } from './bundle-harness-source.mjs'

/**
 * Require a complete, byte-identical payload in the Linux shared-data directory.
 * @param {string} packageRoot - AppImage extraction root or directory populated by dpkg-deb --extract.
 * @param {string} preparedRoot - Original prepared payload whose manifest the installer must preserve.
 * @param {'x64'|'arm64'} arch - Linux native package architecture.
 * @returns {string} Absolute verified payload path, suitable for copying into a production smoke installation.
 */
export function verifyLinuxPackage(packageRoot, preparedRoot, arch) {
  assert.ok(['x64', 'arm64'].includes(arch), 'Linux architecture must be x64 or arm64')
  const payload = resolve(packageRoot, 'usr/share/ClawMaster/harness-source')
  const legacy = join(packageRoot, 'usr/lib/ClawMaster/harness-source')
  assert.equal(lstatSync(legacy, { throwIfNoEntry: false }), undefined,
    'Linux package must not expose its runtime to the usr/lib ELF scan')
  assertPreparedBundle(preparedRoot, 'release')
  assertPreparedBundle(payload, 'release')
  assert.deepEqual(JSON.parse(readFileSync(join(payload, '.bundle-manifest.json'), 'utf8')),
    JSON.parse(readFileSync(join(preparedRoot, '.bundle-manifest.json'), 'utf8')),
    'Linux package manifest must match the original prepared build')
  const binaries = join(payload, `native/system/packages/linux-${arch}/bin`)
  for (const name of ['glibc/system.node', 'musl/system.node', 'landlock-run']) {
    const path = join(binaries, name)
    assert.ok(statSync(path).isFile(), `Linux package must retain ${name}`)
    assert.ok(readFileSync(path).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
      `Linux native resource is not ELF: ${name}`)
  }
  assert.notEqual(statSync(join(binaries, 'landlock-run')).mode & 0o111, 0,
    'Linux sandbox launcher must remain executable')
  return payload
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: {
    'package-root': { type: 'string' },
    'prepared-root': { type: 'string' },
    arch: { type: 'string' },
  }, allowPositionals: false })
  assert.ok(values['package-root'] && values['prepared-root'] && values.arch,
    'Required: --package-root <extracted root> --prepared-root <prepared payload> --arch <x64|arm64>')
  console.log(verifyLinuxPackage(values['package-root'], values['prepared-root'], values.arch))
}
