import assert from 'node:assert/strict'
import test from 'node:test'
import { compareVersions, guardReleaseVersion, programVersionOf } from './release-version-guard.mjs'

const PUBLISHED = [
  'desktop-v0.0.1-beta.1', 'desktop-v0.2.0-beta.6', 'desktop-v0.2.0-release',
  'desktop-v0.2.1', 'desktop-v0.2.2', 'desktop-v0.2.2-fix', 'desktop-v0.2.3',
  'desktop-v0.2.4', 'desktop-v0.2.5', 'desktop-v0.2.6', 'desktop-v0.2.7',
]

test('a desktop tag names either a stable, a display-suffixed stable, or a prerelease program', () => {
  assert.equal(programVersionOf('desktop-v0.2.7'), '0.2.7')
  assert.equal(programVersionOf('desktop-v0.2.0-release'), '0.2.0')
  assert.equal(programVersionOf('desktop-v0.0.1-beta.1'), '0.0.1-beta.1')
  assert.equal(programVersionOf('desktop-v0.2.2-fix'), '0.2.2-fix')
  assert.equal(programVersionOf('v0.2.7'), null)
})

test('program versions order numeric fields first and prereleases below their release', () => {
  assert.ok(compareVersions('0.2.7', '0.2.6') > 0)
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0)
  assert.ok(compareVersions('0.2.0-beta.6', '0.2.0') < 0)
  assert.ok(compareVersions('0.2.0-beta.2', '0.2.0-beta.10') < 0)
  assert.equal(compareVersions('0.2.3', '0.2.3'), 0)
})

test('a version behind a published version of its own line is refused, and names it', () => {
  assert.throws(
    () => guardReleaseVersion({ version: '0.2.3', tags: PUBLISHED }),
    /Desktop version 0\.2\.3 is behind the published 0\.2\.7 in the 0\.2 line/u,
  )
})

test('a release on another line is a reset, not a regression', () => {
  assert.equal(guardReleaseVersion({ version: '0.0.1', tags: PUBLISHED }), '0.0.1')
  assert.equal(guardReleaseVersion({ version: '0.1.0', tags: PUBLISHED }), '0.1.0')
  assert.throws(
    () => guardReleaseVersion({ version: '0.0.1-beta.1', tags: ['desktop-v0.0.1-beta.2'] }),
    /behind the published 0\.0\.1-beta\.2 in the 0\.0 line/u,
  )
})

test('the tag under construction is excluded so a candidate branch can be tagged first', () => {
  assert.equal(guardReleaseVersion({ version: '0.2.8', tags: PUBLISHED, releasing: 'desktop-v0.2.8' }), '0.2.8')
  assert.equal(
    guardReleaseVersion({ version: '0.2.8', tags: [...PUBLISHED, 'desktop-v0.2.8'], releasing: 'desktop-v0.2.8' }),
    '0.2.8',
  )
})

test('a forward stable or prerelease version is accepted', () => {
  assert.equal(guardReleaseVersion({ version: '0.2.8', tags: PUBLISHED }), '0.2.8')
  assert.equal(guardReleaseVersion({ version: '0.3.0-beta.1', tags: PUBLISHED }), '0.3.0-beta.1')
  assert.equal(guardReleaseVersion({ version: '0.1.0', tags: [] }), '0.1.0')
})

test('an unreadable desktop tag or version fails closed instead of weakening the comparison', () => {
  assert.throws(() => guardReleaseVersion({ version: '0.2.8', tags: ['desktop-vnext'] }), /Desktop tag desktop-vnext/u)
  assert.throws(() => guardReleaseVersion({ version: '0.2', tags: [] }), /Unsupported desktop version: 0\.2/u)
})
