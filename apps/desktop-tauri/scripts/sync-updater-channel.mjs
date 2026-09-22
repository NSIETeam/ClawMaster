/** Mirror verified GitHub desktop assets into an immutable HTTPS channel. The caller owns exclusive execution. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { realpathSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createManifest, normalizedAssets, targetSetForPlatforms } from './generate-updater-manifest.mjs'
import { verifyUpdaterSignatures } from './verify-updater-signatures.mjs'

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const REQUEST_TIMEOUT = 30_000
const DOWNLOAD_TIMEOUT = 600_000
const METADATA_LIMIT = 2 * 1024 * 1024
const ARTIFACT_LIMIT = 2 * 1024 * 1024 * 1024
const executeFile = promisify(execFile)

function requireVersion(value) {
  if (typeof value !== 'string' || !STABLE_VERSION.test(value)) throw new Error('Channel requires a stable desktop version')
  return value
}

function compareVersion(left, right) {
  const a = requireVersion(left).split('.').map(BigInt)
  const b = requireVersion(right).split('.').map(BigInt)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function validateOptions(options) {
  for (const name of ['stateDir', 'publicKeyPath']) {
    if (typeof options[name] !== 'string' || !isAbsolute(options[name]) || resolve(options[name]) !== options[name] || options[name] === '/') {
      throw new Error(`${name} must be an absolute normalized path`)
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) || options.repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('repository must identify one GitHub owner/name')
  }
  const signatures = Object.fromEntries(Object.keys(normalizedAssets('0.0.0')).map(target => [target, 'validation']))
  // The manifest generator owns the HTTPS directory rules for both deployment and artifact URLs.
  createManifest({ version: '0.0.0', repository: options.repository, releaseTag: 'desktop-v0.0.0',
    assetBaseUrl: options.baseUrl, pubDate: '2026-01-01T00:00:00Z', notes: '', signatures })
  if (typeof options.baseUrl !== 'string' || !options.baseUrl) throw new Error('baseUrl is required')
  if (typeof options.minisign !== 'string' || !options.minisign.trim()) throw new Error('minisign executable is required')
  if (options.aria2 !== undefined && (typeof options.aria2 !== 'string' || !options.aria2.trim())) throw new Error('aria2 executable must not be empty')
  return { ...options, baseUrl: options.baseUrl.replace(/\/$/, '') }
}

async function directory(path, mode) {
  await mkdir(path, { recursive: true, mode })
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Channel directory must not be a link: ${path}`)
  await chmod(path, mode)
}

async function cleanAbandonedStages(root) {
  for (const name of await readdir(root)) {
    if (!/^\.stage-[A-Za-z0-9]{6}$/.test(name)) continue
    const path = join(root, name)
    const entry = await lstat(path)
    if (entry.isDirectory() && !entry.isSymbolicLink()) await rm(path, { recursive: true })
  }
}

async function readOptional(path) {
  let entry
  try {
    entry = await lstat(path)
  }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Channel metadata must be a regular file: ${path}`)
  return readFile(path, 'utf8')
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function checksums(text) {
  const result = new Map()
  for (const line of text.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]([^/\\\r\n]+)$/.exec(line)
    if (!match || result.has(match[2])) throw new Error('Invalid or duplicate release checksum entry')
    result.set(match[2], match[1])
  }
  return result
}

async function verifyChecksums(root, names) {
  const expected = checksums(await readFile(join(root, 'SHA256SUMS.txt'), 'utf8'))
  for (const name of names) {
    const path = join(root, name)
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || expected.get(name) !== await digest(path)) {
      throw new Error(`Release checksum mismatch: ${name}`)
    }
  }
}

async function request(fetchImpl, url, timeout) {
  const response = await fetchImpl(url, { headers: { Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'ClawMaster-Update-Mirror' }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok || !response.body) throw new Error(`Release request failed: HTTP ${response.status}`)
  return response
}

async function apiRelease(options, fetchImpl) {
  const response = await request(fetchImpl, `https://api.github.com/repos/${options.repository}/releases/latest`, REQUEST_TIMEOUT)
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > METADATA_LIMIT) throw new Error('GitHub release metadata exceeds size limit')
    chunks.push(chunk)
  }
  const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const match = /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-release)?$/.exec(release.tag_name)
  if (!match || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('GitHub Latest must be a published stable desktop release')
  }
  const version = requireVersion(match[1])
  const intel = normalizedAssets(version, 'legacy')['darwin-x86_64']
  const targetSet = release.assets.some(asset => asset.name === intel || asset.name === `${intel}.sig`) ? 'legacy' : 'current'
  const artifacts = Object.values(normalizedAssets(version, targetSet))
  const files = [...artifacts.flatMap(name => [name, `${name}.sig`]), 'latest.json', 'SHA256SUMS.txt']
  const assets = files.map(name => {
    const matches = release.assets.filter(asset => asset.name === name)
    const asset = matches[0]
    const url = `https://github.com/${options.repository}/releases/download/${release.tag_name}/${name}`
    const limit = artifacts.includes(name) ? ARTIFACT_LIMIT : METADATA_LIMIT
    if (matches.length !== 1 || asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) {
      throw new Error(`Missing or invalid GitHub release asset: ${name}`)
    }
    return { name, size: asset.size, url, id: asset.id, digest: asset.digest ?? null }
  })
  return { version, tag: release.tag_name, repository: options.repository, assets }
}

function releaseTargetSet(release) {
  const intel = normalizedAssets(release.version, 'legacy')['darwin-x86_64']
  return release.assets.some(asset => asset.name === intel) ? 'legacy' : 'current'
}

async function download(fetchImpl, asset, destination) {
  const response = await request(fetchImpl, asset.url, DOWNLOAD_TIMEOUT)
  let bytes = 0
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length
    callback(bytes > asset.size ? new Error(`Release download exceeds declared size: ${asset.name}`) : null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  if (bytes !== asset.size) throw new Error(`Incomplete release download: ${asset.name}`)
}

async function segmentedDownload(executable, asset, destination, execute) {
  const args = [
    '--no-conf', '--no-netrc=true', '--enable-rpc=false',
    '--follow-torrent=false', '--follow-metalink=false', '--check-certificate=true', '--async-dns=false',
    '--split=8', '--max-connection-per-server=8', '--min-split-size=1M',
    '--allow-overwrite=false', '--auto-file-renaming=false', '--continue=false',
    '--file-allocation=none', '--max-tries=3', '--connect-timeout=30', '--timeout=60', '--retry-wait=2',
    '--summary-interval=0', '--console-log-level=warn', '--download-result=hide',
    `--dir=${dirname(destination)}`, `--out=${asset.name}`, asset.url,
  ]
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  try {
    await execute(executable, args, { env, timeout: DOWNLOAD_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 32_768, windowsHide: true })
  }
  catch (error) {
    const detail = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
      .replace(/https?:\/\/\S+/gu, '[download URL]').replace(/\u001b\[[0-9;]*m/gu, '').trim().slice(-2048)
    throw new Error(`Segmented release download failed for ${asset.name} (exit ${error.code ?? 'unknown'}, signal ${error.signal ?? 'none'}): ${detail}`, { cause: error })
  }
  const entry = await lstat(destination)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== asset.size) throw new Error(`Incomplete segmented release download: ${asset.name}`)
}

function servedManifest(source, release, options) {
  if (source.version !== release.version || typeof source.notes !== 'string') throw new Error('Source manifest differs from its stable release')
  const targetSet = targetSetForPlatforms(source.platforms)
  if (targetSet !== releaseTargetSet(release)) throw new Error('Source manifest targets differ from the GitHub release assets')
  const expected = createManifest({ version: source.version, repository: options.repository, releaseTag: release.tag,
    targetSet,
    notes: source.notes, pubDate: source.pub_date, signatures: Object.fromEntries(Object.entries(source.platforms ?? {}).map(([target, entry]) => [target, entry.signature])) })
  for (const [target, entry] of Object.entries(expected.platforms)) {
    if (source.platforms?.[target]?.url !== entry.url) throw new Error(`Source updater URL differs from the GitHub release: ${target}`)
  }
  return createManifest({ version: source.version, repository: options.repository, releaseTag: release.tag,
    targetSet,
    notes: source.notes, pubDate: source.pub_date, signatures: Object.fromEntries(Object.entries(source.platforms).map(([target, entry]) => [target, entry.signature])),
    assetBaseUrl: `${options.baseUrl}/versions/${release.version}` })
}

async function verifyPublished(options, release, versionDir, evidenceDir) {
  const receipt = await readOptional(join(evidenceDir, 'release.json'))
  if (receipt !== serialized(release)) throw new Error('Immutable release metadata differs from GitHub Latest')
  const source = JSON.parse(await readFile(join(evidenceDir, 'latest.json'), 'utf8'))
  const expected = serialized(servedManifest(source, release, options))
  if (await readOptional(join(versionDir, 'latest.json')) !== expected) throw new Error('Immutable server manifest differs from its verified release')
  const artifacts = Object.values(normalizedAssets(release.version, releaseTargetSet(release)))
  await verifyChecksums(versionDir, [...artifacts.flatMap(name => [name, `${name}.sig`]), 'latest.json', 'clawmaster-release-signing.pub'])
  if ((await readFile(join(versionDir, 'clawmaster-release-signing.pub'), 'utf8')).trim() !== (await readFile(options.publicKeyPath, 'utf8')).trim()) {
    throw new Error('Published key differs from the pinned release key')
  }
  await verifyUpdaterSignatures({ assetsDir: versionDir, manifestPath: join(versionDir, 'latest.json'), publicKeyPath: options.publicKeyPath, minisign: options.minisign })
  return expected
}

/**
 * Synchronize one stable GitHub release under an externally held exclusive lock.
 * Failed downloads and validation preserve public/latest.json; published version directories are immutable.
 * @param {{ stateDir: string, publicKeyPath: string, baseUrl: string, repository?: string, minisign?: string, aria2?: string }} input
 * @param {{ fetchImpl?: typeof fetch, executeFileImpl?: typeof executeFile }} dependencies
 * @returns {Promise<{ status: 'published' | 'current', version: string }>} Publication outcome.
 */
export async function syncUpdaterChannel(input, { fetchImpl = fetch, executeFileImpl = executeFile } = {}) {
  const options = validateOptions({ repository: 'NSIETeam/ClawMaster-Desktop', minisign: 'minisign', ...input })
  const publicDir = join(options.stateDir, 'public')
  const versionsDir = join(publicDir, 'versions')
  const evidenceRoot = join(options.stateDir, 'evidence')
  for (const path of [options.stateDir, publicDir, versionsDir]) await directory(path, 0o755)
  await directory(evidenceRoot, 0o700)
  await cleanAbandonedStages(options.stateDir)
  const latestPath = join(publicDir, 'latest.json')
  const current = await readOptional(latestPath)
  const currentVersion = current === null ? null : requireVersion(JSON.parse(current).version)
  const release = await apiRelease(options, fetchImpl)
  if (currentVersion !== null && compareVersion(release.version, currentVersion) < 0) throw new Error('GitHub Latest would downgrade the published channel')
  const versionDir = join(versionsDir, release.version)
  const evidenceDir = join(evidenceRoot, release.version)
  let existing
  try {
    existing = await lstat(versionDir)
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let manifest
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Immutable version directory must not be a link')
    manifest = await verifyPublished(options, release, versionDir, evidenceDir)
  }
  else {
    if (currentVersion === release.version) throw new Error('Current immutable release directory is missing')
    const stage = await mkdtemp(join(options.stateDir, '.stage-'))
    try {
      const sourceDir = join(stage, 'source')
      const servedDir = join(stage, 'public')
      await directory(sourceDir, 0o700)
      await directory(servedDir, 0o755)
      const artifactNames = new Set(Object.values(normalizedAssets(release.version, releaseTargetSet(release))))
      for (const asset of release.assets) {
        const destination = join(sourceDir, asset.name)
        if (options.aria2 !== undefined && artifactNames.has(asset.name)) await segmentedDownload(options.aria2, asset, destination, executeFileImpl)
        else await download(fetchImpl, asset, destination)
      }
      await verifyChecksums(sourceDir, release.assets.map(asset => asset.name).filter(name => name !== 'SHA256SUMS.txt'))
      const source = JSON.parse(await readFile(join(sourceDir, 'latest.json'), 'utf8'))
      manifest = serialized(servedManifest(source, release, options))
      await verifyUpdaterSignatures({ assetsDir: sourceDir, manifestPath: join(sourceDir, 'latest.json'), publicKeyPath: options.publicKeyPath, minisign: options.minisign })
      const servedNames = release.assets.map(asset => asset.name).filter(name => name !== 'latest.json' && name !== 'SHA256SUMS.txt')
      for (const name of servedNames) {
        await rename(join(sourceDir, name), join(servedDir, name))
        await chmod(join(servedDir, name), 0o644)
      }
      await writeFile(join(servedDir, 'latest.json'), manifest, { flag: 'wx', mode: 0o644 })
      await copyFile(options.publicKeyPath, join(servedDir, 'clawmaster-release-signing.pub'))
      await chmod(join(servedDir, 'clawmaster-release-signing.pub'), 0o644)
      servedNames.push('latest.json', 'clawmaster-release-signing.pub')
      const sums = []
      for (const name of servedNames.sort()) sums.push(`${await digest(join(servedDir, name))}  ${name}`)
      await writeFile(join(servedDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, { flag: 'wx', mode: 0o644 })
      await verifyUpdaterSignatures({ assetsDir: servedDir, manifestPath: join(servedDir, 'latest.json'), publicKeyPath: options.publicKeyPath, minisign: options.minisign })
      await writeFile(join(sourceDir, 'release.json'), serialized(release), { flag: 'wx', mode: 0o600 })
      const priorReceipt = await readOptional(join(evidenceDir, 'release.json'))
      if (priorReceipt === null) await rename(sourceDir, evidenceDir)
      else if (priorReceipt !== serialized(release)
        || await readFile(join(evidenceDir, 'latest.json'), 'utf8') !== await readFile(join(sourceDir, 'latest.json'), 'utf8')
        || await readFile(join(evidenceDir, 'SHA256SUMS.txt'), 'utf8') !== await readFile(join(sourceDir, 'SHA256SUMS.txt'), 'utf8')) {
        throw new Error('Immutable source evidence differs from the candidate release')
      }
      await rename(servedDir, versionDir)
    }
    finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  if (currentVersion === release.version) {
    if (current !== manifest) throw new Error('Current manifest differs from its immutable release')
    return { status: 'current', version: release.version }
  }
  const pending = join(publicDir, `.latest-${randomUUID()}.json`)
  try {
    await writeFile(pending, manifest, { flag: 'wx', mode: 0o644 })
    await rename(pending, latestPath)
  }
  finally {
    await rm(pending, { force: true })
  }
  return { status: 'published', version: release.version }
}

/** @param {string[]} args @returns {{ stateDir: string, publicKeyPath: string, baseUrl: string, repository: string, minisign: string, aria2?: string }} Validated deployment options. */
export function parseArguments(args) {
  const names = { '--state-dir': 'stateDir', '--public-key': 'publicKeyPath', '--base-url': 'baseUrl', '--repository': 'repository', '--minisign': 'minisign', '--aria2': 'aria2' }
  const options = { repository: 'NSIETeam/ClawMaster-Desktop', minisign: 'minisign' }
  const seen = new Set()
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]]
    if (!name || seen.has(name) || args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error('Unknown, duplicate or incomplete channel option')
    seen.add(name)
    options[name] = args[index + 1]
  }
  return validateOptions(options)
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await syncUpdaterChannel(parseArguments(process.argv.slice(2)))))
  }
  catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
