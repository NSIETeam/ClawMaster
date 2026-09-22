/** Record shipped installer sizes against the non-blocking 20 MiB optimization target. */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { lstat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { acceptanceTargetsForVersion } from './release-acceptance.mjs'
import { normalizedAssets } from './generate-updater-manifest.mjs'

export const PACKAGE_OPTIMIZATION_TARGET_BYTES = 20 * 1024 * 1024

function installerAssets(version) {
  const names = normalizedAssets(version, /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/u.test(version) ? 'beta' : 'current')
  const targets = acceptanceTargetsForVersion(version)
  const result = {}
  for (const key of Object.keys(targets)) {
    if (key === 'macos-arm64-dmg') result[key] = `clawmaster-${version}-macos-arm64.dmg`
    else if (key === 'windows-x64-nsis') result[key] = names['windows-x86_64']
    else if (key === 'linux-x64-appimage') result[key] = names['linux-x86_64']
    else if (key === 'linux-x64-deb') result[key] = names['linux-x86_64-deb']
    else if (key === 'android-universal-apk') result[key] = `clawmaster-${version}-android-universal.apk`
  }
  return result
}

/** @param {{assetsDir:string,version:string,sourceCommit:string}} options Installed installer directory and candidate identity. @returns {Promise<object>} Stable per-platform byte measurements; exceeding 20 MiB is reported only. */
export async function createPackageSizeReport({ assetsDir, version, sourceCommit }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/u)
  const root = resolve(assetsDir)
  const installers = []
  for (const [target, file] of Object.entries(installerAssets(version)).sort(([a], [b]) => a.localeCompare(b))) {
    const info = await lstat(join(root, file))
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0, `Installer must be a nonempty regular file: ${file}`)
    installers.push({ target, file, sizeBytes: info.size, withinOptimizationTarget: info.size <= PACKAGE_OPTIMIZATION_TARGET_BYTES })
  }
  return { schemaVersion: 1, version, sourceCommit, optimizationTargetBytes: PACKAGE_OPTIMIZATION_TARGET_BYTES, installers }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: { 'assets-dir': { type: 'string' }, version: { type: 'string' }, commit: { type: 'string' }, output: { type: 'string' } } })
  assert.ok(values['assets-dir'] && values.version && values.commit, 'Required: --assets-dir <dir> --version <version> --commit <full SHA> [--output <file>]')
  const report = await createPackageSizeReport({ assetsDir: values['assets-dir'], version: values.version, sourceCommit: values.commit })
  const output = resolve(values.output ?? join(values['assets-dir'], 'package-size-report.json'))
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  const aboveTarget = report.installers.filter(item => !item.withinOptimizationTarget)
  process.stdout.write(`${JSON.stringify({ output, installers: report.installers.length, aboveOptimizationTarget: aboveTarget.map(item => item.file) })}\n`)
}
