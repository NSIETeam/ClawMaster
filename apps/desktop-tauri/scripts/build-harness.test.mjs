import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { brandClawMasterWebAssets, clawmasterBuildEnvironment, verifyClawMasterClient } from './build-harness.ts'

test('desktop build replaces an inherited official profile before any client is compiled', () => {
  assert.deepEqual(clawmasterBuildEnvironment({
    PATH: '/bin', DSH_BUILD_CLIENT_PROFILE: 'official',
    DSH_CLIENT_BUILD_PROFILE: 'official', DSH_CLIENT_TITLE: 'DeepSeek Harness',
  }), { PATH: '/bin', DSH_CLIENT_BUILD_PROFILE: 'clawmaster', DSH_CLIENT_TITLE: 'ClawMaster' })
})

test('packaging rejects upstream branding and artifacts changed after verification', t => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-client-brand-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dist = join(root, 'apps/web/dist')
  mkdirSync(dist, { recursive: true })
  const desktop = join(root, 'apps/desktop-tauri')
  mkdirSync(desktop, { recursive: true })
  const icon = readFileSync(new URL('../app-icon.png', import.meta.url))
  writeFileSync(join(desktop, 'app-icon.png'), icon)
  const manifest = {
    name: 'DeepSeek Harness', short_name: 'DSH', start_url: '/', display: 'fullscreen',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }
  const manifestPath = join(dist, 'manifest.webmanifest')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(dist, 'favicon.svg'), '<svg><path id="upstream-whale"/></svg>')
  const index = join(dist, 'index.html')
  writeFileSync(index, '<title>DeepSeek Harness</title>')
  writeClientBuildRecord(root, { DSH_CLIENT_BUILD_PROFILE: 'official', DSH_CLIENT_TITLE: 'DeepSeek Harness' })
  assert.throws(() => verifyClawMasterClient(root), /DSH_CLIENT_TITLE/)
  writeFileSync(index, '<title>ClawMaster</title>')
  writeClientBuildRecord(root, { DSH_CLIENT_BUILD_PROFILE: 'clawmaster', DSH_CLIENT_TITLE: 'ClawMaster' })
  assert.throws(() => verifyClawMasterClient(root), /Web install metadata/u)
  brandClawMasterWebAssets(root)
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), { ...manifest, name: 'ClawMaster', short_name: 'ClawMaster' })
  const favicon = readFileSync(join(dist, 'favicon.svg'), 'utf8')
  const encoded = /href="data:image\/png;base64,([^"]+)"/u.exec(favicon)?.[1]
  assert.ok(encoded)
  assert.deepEqual(Buffer.from(encoded, 'base64'), icon)
  assert.doesNotMatch(favicon, /upstream-whale/u)
  assert.doesNotThrow(() => verifyClawMasterClient(root))
  writeFileSync(index, '<title>Stale build</title>')
  assert.throws(() => verifyClawMasterClient(root), /artifacts differ/)
})
