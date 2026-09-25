/** Prepare App Store Connect credentials for a notarized desktop bundle build. */
import { Buffer } from 'node:buffer'
import { chmodSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fields = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_CONTENT',
  'APPLE_TEAM_ID',
]

/** @param {string} value @param {string} label @returns {Buffer} Decode a canonical base64 value without logging it. */
function decodeBase64(value, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} must contain base64-encoded file bytes`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0) throw new Error(`${label} must not be empty`)
  return bytes
}

/**
 * Validate the macOS signing inputs and materialize the one-time-download API key in the runner temp directory.
 * @param {NodeJS.ProcessEnv} environment GitHub Actions environment values.
 * @param {string} temporaryDirectory Runner-private temporary directory.
 * @returns {{signed: boolean, keyPath?: string}} Whether Tauri will sign and notarize this candidate.
 */
export function prepareMacSigning(environment = process.env, temporaryDirectory = process.env.RUNNER_TEMP) {
  const identity = environment.APPLE_SIGNING_IDENTITY ?? '-'
  const supplied = fields.filter(field => (environment[field] ?? '') !== '')
  if (supplied.length === 0 && identity === '-') return { signed: false }
  if (supplied.length !== fields.length || identity === '-') {
    throw new Error(`macOS signing requires APPLE_SIGNING_IDENTITY and all of: ${fields.join(', ')}`)
  }
  if (!/^Developer ID Application: .+\([A-Z0-9]{10}\)$/u.test(identity)) {
    throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity with its Team ID')
  }
  if (!/^[0-9A-F-]{36}$/iu.test(environment.APPLE_API_ISSUER ?? '')) throw new Error('APPLE_API_ISSUER must be an App Store Connect issuer UUID')
  if (!/^[A-Z0-9]{10}$/u.test(environment.APPLE_API_KEY ?? '')) throw new Error('APPLE_API_KEY must be a 10-character key ID')
  if (!/^[A-Z0-9]{10}$/u.test(environment.APPLE_TEAM_ID ?? '')) throw new Error('APPLE_TEAM_ID must be a 10-character Team ID')
  if (!identity.endsWith(`(${environment.APPLE_TEAM_ID})`)) throw new Error('APPLE_SIGNING_IDENTITY Team ID differs from APPLE_TEAM_ID')
  decodeBase64(environment.APPLE_CERTIFICATE, 'APPLE_CERTIFICATE')
  const key = decodeBase64(environment.APPLE_API_KEY_CONTENT, 'APPLE_API_KEY_CONTENT')
  if (!key.toString('utf8').includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error('APPLE_API_KEY_CONTENT must decode to the App Store Connect .p8 private key')
  }
  if (!temporaryDirectory) throw new Error('RUNNER_TEMP is required to prepare the App Store Connect key')
  const githubEnv = environment.GITHUB_ENV
  if (!githubEnv) throw new Error('GITHUB_ENV is required to pass the private key path to Tauri')
  const keyPath = join(temporaryDirectory, `AuthKey_${environment.APPLE_API_KEY}.p8`)
  writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' })
  chmodSync(keyPath, 0o600)
  writeFileSync(githubEnv, `APPLE_API_KEY_PATH=${keyPath}\n`, { flag: 'a' })
  return { signed: true, keyPath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = prepareMacSigning()
  process.stdout.write(result.signed ? 'macOS Developer ID signing and notarization credentials are configured.\n' : 'macOS build will use ad-hoc signing without notarization; only reset 0.0.1 acceptance permits this state.\n')
}
