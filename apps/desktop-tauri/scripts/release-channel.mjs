/** Resolve the desktop tag, program version and GitHub publication channel. */
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateVersion } from './generate-updater-manifest.mjs'

/**
 * Stable tags may carry a display-only `-release` suffix; installer versions remain stable SemVer.
 * @param {{ version: string, tauriVersion: string, tag: string }} input
 * @returns {{ version: string, tag: string, title: string, prerelease: boolean, latest: boolean }}
 */
export function resolveReleaseChannel({ version, tauriVersion, tag }) {
  validateVersion(version)
  if (tauriVersion !== version) throw new Error('Desktop package and Tauri versions must match')
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
  const expected = `desktop-v${version}`
  if (tag !== expected && !(stable && tag === `${expected}-release`)) {
    throw new Error('Release tag does not match the desktop version and channel')
  }
  return { version, tag, title: `ClawMaster WatchDog ${tag.slice('desktop-v'.length)}`, prerelease: !stable, latest: stable }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = new URL('../', import.meta.url)
  const pkg = JSON.parse(await readFile(new URL('package.json', desktop), 'utf8'))
  const tauri = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', desktop), 'utf8'))
  const channel = resolveReleaseChannel({ version: pkg.version, tauriVersion: tauri.version, tag: process.argv[2] })
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(channel).map(([key, value]) => `${key}=${value}\n`).join(''))
  }
  console.log(JSON.stringify(channel))
}
