/** Verify the generated Tauri channel and every updater artifact with the Minisign CLI. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { normalizedAssets, validateVersion } from './generate-updater-manifest.mjs'

const execute = promisify(execFile)

function decodeEnvelope(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`)
  const encoded = value.trim()
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) throw new Error(`Invalid base64 ${label}`)
  return decoded
}

/**
 * Reject missing targets, mismatched sidecars and signatures that do not authenticate the artifact.
 * Requires a Minisign executable; no signing key or installation privileges are used.
 * @param {{ assetsDir: string, manifestPath: string, publicKeyPath: string, minisign?: string }} options
 * @returns {Promise<string[]>} Verified artifact filenames.
 */
export async function verifyUpdaterSignatures({ assetsDir, manifestPath, publicKeyPath, minisign = 'minisign' }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateVersion(manifest.version)
  const assets = normalizedAssets(manifest.version)
  if (!manifest.platforms || Object.keys(manifest.platforms).sort().join('\n') !== Object.keys(assets).sort().join('\n')) {
    throw new Error('Updater manifest must contain exactly the supported platform targets')
  }
  const publicKey = decodeEnvelope(await readFile(publicKeyPath, 'utf8'), 'updater public key')
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-update-signatures-'))
  try {
    const decodedKeyPath = join(directory, 'public.key')
    await writeFile(decodedKeyPath, publicKey, { flag: 'wx', mode: 0o600 })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
    for (const [target, asset] of Object.entries(assets)) {
      const entry = manifest.platforms[target]
      if (new URL(entry.url).pathname.split('/').at(-1) !== asset) {
        throw new Error(`Updater URL does not name the verified artifact: ${target}`)
      }
      const assetPath = resolve(assetsDir, asset)
      const sidecar = (await readFile(`${assetPath}.sig`, 'utf8')).trim()
      if (entry.signature !== sidecar) throw new Error(`Updater signature differs from its sidecar: ${asset}`)
      const signaturePath = join(directory, `${target}.minisig`)
      await writeFile(signaturePath, decodeEnvelope(sidecar, `signature for ${asset}`), { flag: 'wx', mode: 0o600 })
      try {
        await execute(minisign, ['-V', '-q', '-m', assetPath, '-p', decodedKeyPath, '-x', signaturePath], {
          env, timeout: 120_000, maxBuffer: 32_768,
        })
      }
      catch (error) {
        throw new Error(`Updater signature verification failed for ${asset}: ${error.message}`, { cause: error })
      }
    }
    return Object.values(assets)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [assetsDir, manifestPath, publicKeyPath, minisign, ...extra] = process.argv.slice(2)
    if (!assetsDir || !manifestPath || !publicKeyPath || extra.length) {
      throw new Error('Usage: verify-updater-signatures.mjs <assets-dir> <latest.json> <public-key> [minisign-path]')
    }
    const verified = await verifyUpdaterSignatures({ assetsDir, manifestPath, publicKeyPath, minisign })
    console.log(`verify-updater-signatures: verified ${verified.length} updater artifacts`)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
