/** Select platform builders from the explicit desktop release tag. */
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_TARGETS = Object.freeze([
  { runner: 'windows-2025', target: 'x86_64-pc-windows-msvc', bundles: 'nsis', asset_platform: 'windows', asset_arch: 'x64' },
  { runner: 'macos-15', target: 'aarch64-apple-darwin', bundles: 'app,dmg', asset_platform: 'macos', asset_arch: 'arm64' },
  { runner: 'ubuntu-22.04', target: 'x86_64-unknown-linux-gnu', bundles: 'appimage,deb', asset_platform: 'linux', asset_arch: 'x64' },
])

/** @param {string} tag @returns {typeof BUILD_TARGETS[number][]} Exact beta tags build the requested Windows and Apple Silicon beta scope. */
export function releaseBuildMatrix(tag) {
  const beta = /^desktop-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.[1-9]\d*$/u.test(tag)
  if (!/^desktop-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) throw new Error('Release tag must be desktop-v<semver>')
  if (tag.includes('-beta') && !beta) throw new Error('Beta release tags must use desktop-vX.Y.Z-beta.N with N greater than zero')
  return beta ? BUILD_TARGETS.slice(0, 2) : [...BUILD_TARGETS]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  if (!tag) throw new Error('Usage: release-build-matrix.mjs <desktop-v<semver>>')
  const matrix = { include: releaseBuildMatrix(tag) }
  process.stdout.write(`matrix=${JSON.stringify(matrix)}\n`)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`)
}
