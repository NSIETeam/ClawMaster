/** Stage native update bytes with Tauri-compatible Minisign verification; never launch an installer. */
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { downloadVerifiedFile, fetchBytes, httpsUrl, type DownloadOptions, type RequestOptions, type VerifiedDownload } from './download.ts'

const suffixes = {
  'windows-x86_64': 'windows-x64-setup.exe',
  'darwin-x86_64': 'macos-x64.app.tar.gz',
  'darwin-aarch64': 'macos-arm64.app.tar.gz',
  'linux-x86_64': 'linux-x64.AppImage',
  'linux-x86_64-deb': 'linux-x64.deb',
} as const
const entry = z.strictObject({ url: z.string(), signature: z.string().min(1) })
const releaseSchema = z.strictObject({
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
  notes: z.string(),
  pub_date: z.iso.datetime(),
  platforms: z.strictObject({
    'windows-x86_64': entry, 'darwin-x86_64': entry, 'darwin-aarch64': entry,
    'linux-x86_64': entry, 'linux-x86_64-deb': entry,
  }),
})

/** Supported Tauri installer-specific update target. */
export type NativeTarget = keyof typeof suffixes
/** Validated native manifest; payload trust is established only by signature verification. */
export type NativeRelease = z.infer<typeof releaseSchema>
/** Verified file requiring the native installer before it becomes active. */
export interface PreparedNativeUpdate extends VerifiedDownload { status: 'requires-native-installer'; version: string; target: NativeTarget }

/** Read a static Tauri manifest restricted to its configured HTTPS update server.
 * @param options Endpoint, metadata limits and optional cancellation.
 * @returns Validated manifest; this does not authenticate or install payload bytes.
 */
export async function fetchNativeRelease(options: RequestOptions & { manifestUrl: string }): Promise<NativeRelease> {
  const endpoint = httpsUrl(options.manifestUrl)
  const release = releaseSchema.parse(JSON.parse((await fetchBytes(options.manifestUrl, options)).toString('utf8')))
  for (const target of Object.keys(suffixes) as NativeTarget[]) {
    const url = httpsUrl(release.platforms[target].url)
    if (url.origin !== endpoint.origin || url.pathname !== `/updates/clawmaster/versions/${release.version}/clawmaster-${release.version}-${suffixes[target]}`) {
      throw new Error('Native artifact URL is outside its configured version directory')
    }
  }
  return release
}

function envelope(value: string, name: string): string {
  const encoded = value.trim()
  const bytes = Buffer.from(encoded, 'base64')
  if (!encoded || bytes.toString('base64') !== encoded) throw new Error(`Invalid Tauri ${name} envelope`)
  return bytes.toString('utf8')
}

// A short-lived worker releases the verifier's WASM memory after large installer checks.
const verifyWorker = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
try {
  const library = require(workerData.modulePath);
  const key = library.PublicKey.decode(workerData.publicKey);
  try {
    const signature = library.Signature.decode(workerData.signature);
    try {
      if (key.verify(readFileSync(workerData.path), signature) !== true) throw new Error('Invalid signature');
      parentPort.postMessage({ verified: true });
    } finally { signature.free(); }
  } finally { key.free(); }
} catch { parentPort.postMessage({ verified: false }); }
`

/** Verify Tauri-wrapped signatures using the maintained Minisign implementation in an owned worker.
 * @param path Downloaded file in private staging.
 * @param publicKey Pinned base64 Tauri public-key envelope.
 * @param signature Base64 Tauri signature envelope.
 * @param signal Cancellation or caller deadline; worker termination is awaited.
 * @returns Resolves only after successful verification and worker exit.
 */
export async function verifyNativeFile(path: string, publicKey: string, signature: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const decodedKey = envelope(publicKey, 'public key')
  const decodedSignature = envelope(signature, 'signature')
  const require = createRequire(import.meta.url)
  const worker = new Worker(verifyWorker, {
    eval: true, execArgv: [], env: {},
    workerData: { modulePath: require.resolve('@threema/wasm-minisign-verify'), path, publicKey: decodedKey, signature: decodedSignature },
  })
  await new Promise<void>((resolve, reject) => {
    let verified = false
    let failure: Error | undefined
    const abort = (): void => { void worker.terminate() }
    worker.on('message', (message: unknown) => {
      verified = typeof message === 'object' && message !== null && 'verified' in message && message.verified === true
      if (!verified) failure = new Error('Native update signature verification failed')
    })
    worker.once('error', () => { failure = new Error('Native signature verifier failed') })
    worker.once('exit', code => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (failure || !verified || code !== 0) reject(failure ?? new Error('Native update signature verification failed'))
      else resolve()
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Download a selected native target and authenticate it without installation or restart.
 * @param release Validated static manifest.
 * @param target Current native installer target.
 * @param options Pinned native key, private cache, limits and cancellation.
 * @returns Verified cache file explicitly requiring the native installer.
 */
export async function prepareNativeUpdate(release: NativeRelease, target: NativeTarget, options: Omit<DownloadOptions, 'verify'> & { publicKey: string }): Promise<PreparedNativeUpdate> {
  const artifact = release.platforms[target]
  const file = await downloadVerifiedFile({ url: artifact.url }, {
    ...options,
    verify: (path, signal) => verifyNativeFile(path, options.publicKey, artifact.signature, signal),
  })
  return { ...file, status: 'requires-native-installer', version: release.version, target }
}
