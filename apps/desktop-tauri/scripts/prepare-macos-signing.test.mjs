import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareMacSigning } from './prepare-macos-signing.mjs'

const identity = 'Developer ID Application: ClawMaster (ABCDEFGHIJ)'
const privateKey = Buffer.from('-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n').toString('base64')
const valid = {
  APPLE_SIGNING_IDENTITY: identity,
  APPLE_CERTIFICATE: Buffer.from('p12').toString('base64'),
  APPLE_CERTIFICATE_PASSWORD: 'fixture-password',
  APPLE_API_ISSUER: '12345678-1234-1234-1234-123456789abc',
  APPLE_API_KEY: 'ABCDEFGHIJ',
  APPLE_API_KEY_CONTENT: privateKey,
  APPLE_TEAM_ID: 'ABCDEFGHIJ',
}

test('an empty signing configuration remains an unsigned candidate', () => {
  assert.deepEqual(prepareMacSigning({ APPLE_SIGNING_IDENTITY: '-' }, '/tmp'), { signed: false })
})

test('partial signing configurations fail before the build starts', () => {
  assert.throws(() => prepareMacSigning({ APPLE_SIGNING_IDENTITY: identity }, '/tmp'), /requires APPLE_SIGNING_IDENTITY/u)
  assert.throws(() => prepareMacSigning({ ...valid, APPLE_TEAM_ID: 'KLMNOPQRST' }, '/tmp'), /Team ID differs/u)
  assert.throws(() => prepareMacSigning({ ...valid, APPLE_API_KEY_CONTENT: 'bad' }, '/tmp'), /base64/u)
})

test('complete credentials create a private App Store Connect key file for the runner', t => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster signing '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const githubEnv = join(root, 'github-env')
  writeFileSync(githubEnv, '')
  const result = prepareMacSigning({ ...valid, GITHUB_ENV: githubEnv }, root)
  assert.equal(result.signed, true)
  assert.equal(readFileSync(result.keyPath, 'utf8'), Buffer.from(privateKey, 'base64').toString('utf8'))
  assert.equal(statSync(result.keyPath).mode & 0o777, 0o600)
  assert.equal(readFileSync(githubEnv, 'utf8'), `APPLE_API_KEY_PATH=${result.keyPath}\n`)
})
