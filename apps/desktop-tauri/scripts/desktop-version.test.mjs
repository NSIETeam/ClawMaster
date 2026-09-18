import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { syncDesktopVersion, verifyDesktopVersion } from './desktop-version.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'version.json'), '{"desktop":"0.2.5"}\n')
  await writeFile(path.join(root, 'package.json'), '{"name":"desktop","version":"0.2.5"}\n')
  await mkdir(path.join(root, 'src-tauri'))
  await writeFile(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "desktop"\nversion = "0.2.5"\n\n[dependencies]\nversion = "dependency-version-is-not-release"\n')
  await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), '{"version":"0.2.5"}\n')
  return root
}

test('version.json is the desktop package, Cargo, and Tauri version source', async t => {
  const root = await fixture(t)
  assert.equal(await verifyDesktopVersion(root), '0.2.5')
})

test('check rejects drift in each generated build version and sync repairs it', async t => {
  const root = await fixture(t)
  for (const file of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']) {
    const pathName = path.join(root, file)
    const original = await readFile(pathName, 'utf8')
    const drifted = file.endsWith('Cargo.toml')
      ? original.replace('version = "0.2.5"', 'version = "0.2.4"')
      : `${JSON.stringify({ ...JSON.parse(original), version: '0.2.4' }, null, 2)}\n`
    await writeFile(pathName, drifted)
    await assert.rejects(verifyDesktopVersion(root), new RegExp(`${file.replaceAll('/', '\\/')} reports 0\\.2\\.4`))
    assert.equal(await syncDesktopVersion(root), '0.2.5')
    assert.equal(await verifyDesktopVersion(root), '0.2.5')
  }
})

test('sync rejects an invalid canonical version without changing derived versions', async t => {
  const root = await fixture(t)
  await writeFile(path.join(root, 'version.json'), '{"desktop":"0.2"}\n')
  const before = await readFile(path.join(root, 'package.json'), 'utf8')
  await assert.rejects(syncDesktopVersion(root), /Invalid version/u)
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before)
})
