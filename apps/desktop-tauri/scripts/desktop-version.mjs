/** Keep desktop package, Cargo and Tauri versions generated from version.json. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateVersion } from './generate-updater-manifest.mjs'

const DESKTOP_FILES = Object.freeze([
  {
    path: 'package.json',
    read: content => JSON.parse(content).version,
    write: (content, version) => `${JSON.stringify({ ...JSON.parse(content), version }, null, 2)}\n`,
  },
  {
    path: 'src-tauri/Cargo.toml',
    read: content => /^\[package\]\s*\n(?:(?!\[).)*?^version\s*=\s*"([^"]+)"\s*$/msu.exec(content)?.[1],
    write: (content, version) => {
      let replaced = false
      const output = content.replace(/^(\[package\]\s*\n(?:(?!\[).)*?^version\s*=\s*)"[^"]+"/msu, (_match, prefix) => {
        replaced = true
        return `${prefix}"${version}"`
      })
      if (!replaced) throw new Error('Desktop Cargo.toml has no [package].version')
      return output
    },
  },
  {
    path: 'src-tauri/tauri.conf.json',
    read: content => JSON.parse(content).version,
    write: (content, version) => `${JSON.stringify({ ...JSON.parse(content), version }, null, 2)}\n`,
  },
])

/** @param {string} root Desktop project directory. @returns {Promise<string>} Canonical release version. */
export async function readDesktopVersion(root) {
  const source = JSON.parse(await readFile(resolve(root, 'version.json'), 'utf8'))
  if (typeof source.desktop !== 'string') throw new Error('version.json must contain a desktop version string')
  validateVersion(source.desktop)
  return source.desktop
}

/** @param {string} root Desktop project directory. */
export async function verifyDesktopVersion(root) {
  const expected = await readDesktopVersion(root)
  for (const file of DESKTOP_FILES) {
    const actual = file.read(await readFile(resolve(root, file.path), 'utf8'))
    if (actual !== expected) throw new Error(`${file.path} reports ${String(actual)}; version.json reports ${expected}`)
  }
  return expected
}

/** @param {string} root Desktop project directory. */
export async function syncDesktopVersion(root) {
  const version = await readDesktopVersion(root)
  for (const file of DESKTOP_FILES) {
    const path = resolve(root, file.path)
    const content = await readFile(path, 'utf8')
    await writeFile(path, file.write(content, version))
  }
  await verifyDesktopVersion(root)
  return version
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const mode = process.argv[2]
  if (mode === '--sync') {
    console.log(`Synchronized desktop package, Cargo and Tauri versions to ${await syncDesktopVersion(root)}`)
  } else if (mode === '--check') {
    console.log(`Desktop version sources agree at ${await verifyDesktopVersion(root)}`)
  } else {
    throw new Error('Use --sync or --check')
  }
}
