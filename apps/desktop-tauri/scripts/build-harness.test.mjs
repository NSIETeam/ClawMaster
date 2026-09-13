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
  const frontend = join(root, 'frontends/dsh/src')
  mkdirSync(frontend, { recursive: true })
  const icon = readFileSync(new URL('../../../frontends/dsh/src/clawmaster.svg', import.meta.url), 'utf8')
  const iconPath = join(frontend, 'clawmaster.svg')
  writeFileSync(iconPath, icon)
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
  assert.equal(favicon, icon)
  assert.doesNotMatch(favicon, /upstream-whale/u)
  assert.doesNotThrow(() => verifyClawMasterClient(root))
  for (const replacement of [
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,cG5n"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/><image href="app-icon.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/><filter><feImage href="app-icon.png"/></filter></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/><foreignObject><img src="app-icon.png"/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/><style>svg{background:url(data:image/png;base64,cG5n)}</style></svg>',
  ]) {
    writeFileSync(iconPath, replacement)
    assert.throws(() => brandClawMasterWebAssets(root), /SVG paths without embedded or linked images/u)
    assert.throws(() => verifyClawMasterClient(root), /SVG paths without embedded or linked images/u)
    assert.equal(readFileSync(join(dist, 'favicon.svg'), 'utf8'), icon)
  }
  writeFileSync(iconPath, icon)
  writeFileSync(index, '<title>Stale build</title>')
  assert.throws(() => verifyClawMasterClient(root), /artifacts differ/)
})
