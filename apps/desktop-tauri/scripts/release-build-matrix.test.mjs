import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseBuildMatrix } from './release-build-matrix.mjs'

test('beta tags select only Windows NSIS and macOS Apple Silicon builders', () => {
  assert.deepEqual(releaseBuildMatrix('desktop-v0.2.4-beta.1').map(({ asset_platform, asset_arch, bundles }) => [asset_platform, asset_arch, bundles]), [
    ['windows', 'x64', 'nsis'], ['macos', 'arm64', 'app,dmg'],
  ])
})

test('stable, release-display, and non-beta prerelease tags retain the complete matrix', () => {
  for (const tag of ['desktop-v0.2.3', 'desktop-v0.2.0-release', 'desktop-v0.3.0-rc.1']) {
    assert.equal(releaseBuildMatrix(tag).length, 3, tag)
  }
})

test('invalid and non-monotonic beta tag forms are rejected or stay on the complete lane', () => {
  assert.throws(() => releaseBuildMatrix('desktop-v0.2.4-beta.0'), /Beta release tags/u)
  assert.throws(() => releaseBuildMatrix('v0.2.4-beta.1'), /Release tag/u)
  assert.throws(() => releaseBuildMatrix('desktop-v0.2.4-beta.foo'), /Beta release tags/u)
})
