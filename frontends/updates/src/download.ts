/** Bounded HTTPS reads and verified immutable downloads shared by update channels. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Request limits supplied by the owning deployment configuration. */
export interface RequestOptions {
  requestTimeoutMs: number
  maxCatalogBytes: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** A completed download authenticated before entering the immutable cache. */
export interface VerifiedDownload { path: string; sha256: string; size: number }

/** Download limits and the optional signature verifier run before publication. */
export interface DownloadOptions {
  cacheDir: string
  downloadTimeoutMs: number
  maxDownloadBytes: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  verify?: (path: string, signal: AbortSignal) => Promise<void>
}

/** Validate an HTTPS URL without credentials or normalized path ambiguity.
 * @param value Configured or signed URL.
 * @returns Parsed URL; invalid input throws without echoing credentials.
 */
export function httpsUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error('Update URL must be absolute HTTPS') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^https:\/\/[^/?#\\\s]+(?:\/[^?#\\\s]*)?$/u.test(value)) throw new Error('Invalid update HTTPS URL')
  const path = value.slice(value.indexOf('/', 8))
  if (value.indexOf('/', 8) >= 0 && path !== url.pathname) throw new Error('Ambiguous update URL path')
  let decoded: string[]
  try { decoded = url.pathname.split('/').map(decodeURIComponent) }
  catch { throw new Error('Invalid update URL encoding') }
  if (url.pathname.includes('//') || decoded.some(segment => segment === '.' || segment === '..' || /[/%\\?#\s\u0000-\u001f\u007f]/u.test(segment))) {
    throw new Error('Ambiguous update URL path')
  }
  return url
}

function deadline(timeout: number, parent?: AbortSignal): AbortSignal {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Update timeout must be a positive integer')
  return AbortSignal.any([AbortSignal.timeout(timeout), ...(parent ? [parent] : [])])
}

function byteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Update byte limit must be a positive integer')
}

async function response(url: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  httpsUrl(url)
  signal.throwIfAborted()
  const result = await fetchImpl(url, { signal, redirect: 'error' })
  if (!result.ok || !result.body) throw new Error(`Update request failed: HTTP ${result.status}`)
  return result
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let complete = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) { complete = true; return }
      yield result.value
    }
  }
  finally {
    try { if (!complete) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}

/** Read metadata under a deadline and byte ceiling; redirects fail closed.
 * @param url Trusted HTTPS metadata URL.
 * @param options Deployment limits and optional caller cancellation.
 * @returns Exact response bytes for signature verification before parsing.
 */
export async function fetchBytes(url: string, options: RequestOptions): Promise<Buffer> {
  byteLimit(options.maxCatalogBytes)
  const signal = deadline(options.requestTimeoutMs, options.signal)
  const result = await response(url, signal, options.fetchImpl ?? fetch)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of responseChunks(result.body!)) {
    signal.throwIfAborted()
    size += chunk.length
    if (size > options.maxCatalogBytes) throw new Error('Update metadata exceeds configured byte limit')
    chunks.push(chunk)
  }
  signal.throwIfAborted()
  return Buffer.concat(chunks)
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Download and authenticate a file before publishing its SHA-256 cache directory.
 * @param input Signed file URL and optional expected size and SHA-256.
 * @param options Private cache, limits, cancellation, and optional signature verifier.
 * @returns Verified cache file. Failures remove staging and preserve existing cache entries.
 */
export async function downloadVerifiedFile(input: { url: string; size?: number; sha256?: string }, options: DownloadOptions): Promise<VerifiedDownload> {
  byteLimit(options.maxDownloadBytes)
  if (!isAbsolute(options.cacheDir)) throw new Error('Update cache path must be absolute')
  if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > options.maxDownloadBytes)) throw new Error('Update size exceeds configured byte limit')
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error('Invalid update SHA-256')
  if (!input.sha256 && !options.verify) throw new Error('Update download requires an expected hash or signature verifier')
  const signal = deadline(options.downloadTimeoutMs, options.signal)
  signal.throwIfAborted()
  await mkdir(options.cacheDir, { recursive: true, mode: 0o700 })
  const cache = await lstat(options.cacheDir)
  if (!cache.isDirectory() || cache.isSymbolicLink()) throw new Error('Update cache must be a real directory')
  await chmod(options.cacheDir, 0o700)
  const stage = await mkdtemp(join(options.cacheDir, '.download-'))
  const temporary = join(stage, 'payload')
  try {
    const result = await response(input.url, signal, options.fetchImpl ?? fetch)
    let size = 0
    const hash = createHash('sha256')
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > (input.size ?? options.maxDownloadBytes)) return callback(new Error('Update download exceeds expected byte limit'))
      hash.update(chunk)
      callback(null, chunk)
    } })
    await pipeline(Readable.from(responseChunks(result.body!)), bounded, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
    if (size === 0 || (input.size !== undefined && size !== input.size)) throw new Error('Update download size mismatch')
    const sha256 = hash.digest('hex')
    if (input.sha256 !== undefined && sha256 !== input.sha256) throw new Error('Update SHA-256 mismatch')
    await options.verify?.(temporary, signal)
    signal.throwIfAborted()
    const destination = join(options.cacheDir, `sha256-${sha256}`)
    try { await rename(stage, destination) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error
      const folder = await lstat(destination)
      const existing = await lstat(join(destination, 'payload'))
      if (!folder.isDirectory() || folder.isSymbolicLink() || !existing.isFile() || existing.isSymbolicLink()
        || existing.size !== size || await fileDigest(join(destination, 'payload')) !== sha256) throw new Error('Immutable update cache differs from verified bytes')
    }
    return { path: join(destination, 'payload'), sha256, size }
  }
  finally { await rm(stage, { recursive: true, force: true }) }
}
