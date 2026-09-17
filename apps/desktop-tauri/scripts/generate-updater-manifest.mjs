import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORM_ASSET_SUFFIXES = {
  'windows-x86_64': 'windows-x64-setup.exe',
  'darwin-x86_64': 'macos-x64.app.tar.gz',
  'darwin-aarch64': 'macos-arm64.app.tar.gz',
  'linux-x86_64': 'linux-x64.AppImage',
  'linux-x86_64-deb': 'linux-x64.deb',
}
const BETA_ASSET_SUFFIXES = {
  'windows-x86_64': 'windows-x64-setup.exe',
  'darwin-aarch64': 'macos-arm64.app.tar.gz',
}

const OPTIONS = {
  '--assets-dir': 'assetsDir',
  '--output': 'outputPath',
  '--version': 'version',
  '--repository': 'repository',
  '--release-tag': 'releaseTag',
  '--asset-base-url': 'assetBaseUrl',
  '--target-set': 'targetSet',
  '--notes': 'notes',
  '--notes-file': 'notesFile',
  '--pub-date': 'pubDate',
}

const REQUIRED = ['assetsDir', 'outputPath', 'version', 'repository', 'releaseTag', 'pubDate', 'targetSet']

/** @param {string} version @param {'current'|'legacy'|'beta'} targetSet Stable targets, legacy Intel targets, or the two-platform beta targets. @returns {Record<string, string>} */
export function normalizedAssets(version, targetSet = 'current') {
  if (targetSet !== 'current' && targetSet !== 'legacy' && targetSet !== 'beta') throw new Error('Invalid target set: use current, legacy, or beta')
  if (targetSet === 'beta' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/u.test(version)) {
    throw new Error('The beta target set requires a desktop-vX.Y.Z-beta.N version')
  }
  const suffixes = targetSet === 'beta' ? BETA_ASSET_SUFFIXES : PLATFORM_ASSET_SUFFIXES
  return Object.fromEntries(
    Object.entries(suffixes).filter(([platform]) => targetSet === 'legacy' || platform !== 'darwin-x86_64').map(([platform, suffix]) => [
      platform,
      `clawmaster-${version}-${suffix}`,
    ]),
  )
}

/** @param {unknown} platforms Manifest platform records read from a file or remote response. @returns {'current'|'legacy'|'beta'} The complete supported target set. */
export function targetSetForPlatforms(platforms) {
  if (platforms && typeof platforms === 'object' && !Array.isArray(platforms)) {
    const keys = Object.keys(platforms).sort().join('\n')
    for (const targetSet of ['current', 'legacy', 'beta']) {
      const sampleVersion = targetSet === 'beta' ? '0.0.0-beta.1' : '0.0.0'
      if (keys === Object.keys(normalizedAssets(sampleVersion, targetSet)).sort().join('\n')) return targetSet
    }
  }
  throw new Error('Updater manifest must contain exactly a supported stable, legacy, or beta platform target set')
}

/** @param {string} version */
export function validateVersion(version) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  if (!semver.test(version)) throw new Error(`Invalid version: ${version}`)
}

/** @param {string} pubDate */
export function validatePubDate(pubDate) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(pubDate) || !Number.isFinite(Date.parse(pubDate))) {
    throw new Error(`Invalid pub date: ${pubDate}`)
  }
}

function assetDirectory(value) {
  const invalid = () => new Error('Invalid asset base URL: use an absolute HTTPS directory without credentials, query, fragment or ambiguous path segments')
  const match = /^https:\/\/([^/?#\\\s]+)(\/[^?#\\\s]*)?$/u.exec(value)
  if (!match || match[1].includes('@')) throw invalid()
  let url
  try {
    url = new URL(value)
  }
  catch {
    // URL parser failures contain the input, which may include credentials.
    throw invalid()
  }
  const pathname = match[2] ?? '/'
  let segments
  try {
    segments = pathname.split('/').map(segment => decodeURIComponent(segment))
  }
  catch {
    // Malformed percent escapes are rejected without exposing the supplied URL.
    throw invalid()
  }
  if (url.pathname !== pathname || pathname.includes('//') || segments.some(segment =>
    segment === '.' || segment === '..' || /[/%\\?#\s\u0000-\u001f\u007f]/u.test(segment),
  )) throw invalid()
  return `${url.href}${url.pathname.endsWith('/') ? '' : '/'}`
}

/**
 * An optional HTTPS asset directory replaces GitHub download URLs without changing artifact names or signatures.
 * The directory may end in a slash; credentials, query, fragment and ambiguous paths are rejected.
 * @param {{ version: string, repository: string, releaseTag: string, targetSet?: 'current'|'legacy'|'beta', assetBaseUrl?: string, notes: string, pubDate: string, signatures: Record<string, string> }} options
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }}
 */
export function createManifest(options) {
  const { version, repository, releaseTag, notes, pubDate, signatures } = options
  validateVersion(version)
  validatePubDate(pubDate)
  const assetBaseUrl = options.assetBaseUrl === undefined
    ? `https://github.com/${repository}/releases/download/${releaseTag}/`
    : assetDirectory(options.assetBaseUrl)

  const platforms = Object.fromEntries(
    Object.entries(normalizedAssets(version, options.targetSet)).map(([platform, asset]) => {
      const signature = signatures[platform]?.trim()
      if (!signature) throw new Error(`Missing signature for platform: ${platform}`)
      return [platform, {
        signature,
        url: `${assetBaseUrl}${asset}`,
      }]
    }),
  )
  if (Object.keys(signatures).some(platform => !Object.hasOwn(platforms, platform))) throw new Error('Signatures contain targets outside the selected target set')

  return { version, notes, pub_date: pubDate, platforms }
}

/**
 * @param {string[]} args
 * @returns {{ assetsDir: string, outputPath: string, version: string, repository: string, releaseTag: string, targetSet: 'current'|'legacy'|'beta', assetBaseUrl?: string, notes?: string, notesFile?: string, pubDate: string }}
 */
export function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const key = OPTIONS[option]
    if (!key) throw new Error(`Unknown option: ${option}`)
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${option}`)
    const value = args[index + 1]
    if (value === undefined) throw new Error(`Missing value for option: ${option}`)
    values[key] = value
  }
  normalizedAssets(values.version, values.targetSet)
  for (const key of REQUIRED) {
    if (values[key] === undefined) {
      const option = Object.entries(OPTIONS).find(([, name]) => name === key)?.[0]
      throw new Error(`Missing required option: ${option}`)
    }
  }
  if (values.notes !== undefined && values.notesFile !== undefined) {
    throw new Error('Use either --notes or --notes-file, not both')
  }
  if (values.notes === undefined && values.notesFile === undefined) {
    throw new Error('Missing required option: --notes or --notes-file')
  }
  if (values.assetBaseUrl !== undefined) assetDirectory(values.assetBaseUrl)
  return values
}

/**
 * @param {{ notes?: string, notesFile?: string }} options
 * @returns {Promise<string>}
 */
export async function resolveNotes(options) {
  if (options.notesFile !== undefined) {
    return (await readFile(options.notesFile, 'utf8')).replace(/\r\n/g, '\n')
  }
  return options.notes ?? ''
}

/**
 * @param {{ assetsDir: string, outputPath: string, version: string, repository: string, releaseTag: string, targetSet: 'current'|'legacy', assetBaseUrl?: string, notes?: string, notesFile?: string, pubDate: string }} options
 * @returns {Promise<void>}
 */
export async function writeUpdaterManifest(options) {
  const notes = await resolveNotes(options)
  const assets = normalizedAssets(options.version, options.targetSet)
  const signatures = {}
  for (const [platform, asset] of Object.entries(assets)) {
    const assetPath = resolve(options.assetsDir, asset)
    const signaturePath = `${assetPath}.sig`
    for (const path of [assetPath, signaturePath]) {
      try {
        await access(path)
      }
      catch {
        throw new Error(`Missing release file: ${path}`)
      }
    }
    signatures[platform] = await readFile(signaturePath, 'utf8')
  }

  const manifest = createManifest({ ...options, notes, signatures })
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true })
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2))
    await writeUpdaterManifest(options)
    console.log(`generate-updater-manifest: wrote ${resolve(options.outputPath)}`)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
