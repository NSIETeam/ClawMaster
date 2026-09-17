import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveReleaseChannel } from './release-channel.mjs'

test('release display suffix publishes a stable program version as the latest release', () => {
  assert.deepEqual(resolveReleaseChannel({ version: '0.2.0', tauriVersion: '0.2.0', tag: 'desktop-v0.2.0-release' }), {
    version: '0.2.0', tag: 'desktop-v0.2.0-release', title: 'ClawMaster WatchDog 0.2.0-release', prerelease: false, latest: true, targetSet: 'current',
  })
  assert.equal(resolveReleaseChannel({ version: '0.2.1', tauriVersion: '0.2.1', tag: 'desktop-v0.2.1' }).latest, true)
})

test('beta and release-candidate programs stay outside the stable channel', () => {
  for (const version of ['0.2.0-beta.6', '0.3.0-rc.1', '0.3.0-release']) {
    const result = resolveReleaseChannel({ version, tauriVersion: version, tag: `desktop-v${version}` })
    assert.equal(result.prerelease, true)
    assert.equal(result.latest, false)
    assert.equal(result.targetSet, version.includes('-beta.') ? 'beta' : 'current')
  }
})

test('publication rejects mismatched versions, tags and prerelease aliases', () => {
  for (const input of [
    { version: '0.2.0', tauriVersion: '0.2.1', tag: 'desktop-v0.2.0-release' },
    { version: '0.2.0', tauriVersion: '0.2.0', tag: 'desktop-v0.1.0-release' },
    { version: '0.2.0-beta.6', tauriVersion: '0.2.0-beta.6', tag: 'desktop-v0.2.0-beta.6-release' },
    { version: 'invalid', tauriVersion: 'invalid', tag: 'desktop-vinvalid' },
    { version: '0.2.0', tauriVersion: '0.2.0', tag: 'desktop-v0.2.0-release\nlatest=false' },
  ]) assert.throws(() => resolveReleaseChannel(input))
})
