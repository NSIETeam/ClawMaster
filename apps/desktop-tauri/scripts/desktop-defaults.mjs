/** Prepare the desktop-owned default bundles before the supported `dsh web` launch. */
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Exact external plugin versions included in each desktop installation. */
export const DESKTOP_PLUGIN_VERSIONS = Object.freeze({
  '@xmanrui/dsh-im': '4.20.0',
  'dsh-better-sidebar': '0.19.1',
  '@nanmicoder/dsh-agent-teams': '0.1.17',
  '@openviking/dsh-memory-plugin': '0.3.0',
  'dsh-routing-suite': '0.1.2',
})

/** Desktop insertion layer omitted when a user-installed updater already owns its row. */
export const DESKTOP_UPDATES_BUNDLE = '@clawmaster/dsh-updates'

/** Desktop layers that add features but are not required to open the core application. */
export const DESKTOP_OPTIONAL_BUNDLES = Object.freeze([
  '@xmanrui/dsh-im',
  'dsh-better-sidebar',
  '@nanmicoder/dsh-agent-teams',
  '@openviking/dsh-memory-plugin',
  'dsh-routing-suite',
  '@clawmaster/dsh-notes',
  '@clawmaster/dsh-graph-memory',
  '@clawmaster/dsh-office',
  '@clawmaster/dsh-rpa',
  DESKTOP_UPDATES_BUNDLE,
])

/** Ordered product layers appended after the shipped Web profile. */
export const DESKTOP_BUNDLES = Object.freeze([
  ...Object.keys(DESKTOP_PLUGIN_VERSIONS),
  '@clawmaster/dsh-desktop-policy',
  '@clawmaster/dsh-frontend',
  '@clawmaster/dsh-guard',
  '@clawmaster/dsh-notes',
  '@clawmaster/dsh-graph-memory',
  '@clawmaster/dsh-office',
  '@clawmaster/dsh-rpa',
  DESKTOP_UPDATES_BUNDLE,
])

/** Copy package-declared presets without replacing user files or following directory links. */
function copyMissingPreset(source, destination) {
  mkdirSync(destination, { recursive: true })
  if (!lstatSync(destination).isDirectory()) throw new Error(`Desktop preset directory is not a directory: ${destination}`)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const target = join(destination, entry.name)
    if (entry.isDirectory()) copyMissingPreset(join(source, entry.name), target)
    else if (entry.isFile()) {
      try { copyFileSync(join(source, entry.name), target, constants.COPYFILE_EXCL) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    } else throw new Error(`Desktop preset source must contain only files and directories: ${entry.name}`)
  }
}

/**
 * Merge missing desktop layers without changing user dependencies or patch policy.
 * @param {object} manifest - Parsed profile manifest.
 * @param {boolean} existingUpdater - Preserve a user-installed updater by omitting the desktop insertion layer.
 * @returns {object} A manifest with the desktop layers present once.
 */
export function withDesktopBundles(manifest, existingUpdater = false, availableBundles = DESKTOP_BUNDLES) {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) {
    throw new Error('Desktop Web profile must declare dsh.profile.bundles as package names')
  }
  if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error('Desktop Web profile must include @deepseek-ai/dsh-web-app')
  }
  const available = new Set(availableBundles)
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: [
          ...bundles.filter(name => !DESKTOP_OPTIONAL_BUNDLES.includes(name) || available.has(name)),
          ...availableBundles.filter(name => DESKTOP_BUNDLES.includes(name) && !bundles.includes(name)),
        ].filter(name => !existingUpdater || name !== DESKTOP_UPDATES_BUNDLE),
      },
    },
  }
}

/**
 * Validate bundled artifacts, prepare the Web profile, and create a private IM directory without registering a Workspace.
 * @param {string} root - Provisioned harness root containing apps/cli.
 * @param {string} home - Explicit desktop-selected DSH data directory.
 * @returns {Promise<void>} Resolves after the profile is ready; missing artifacts reject before mutation.
 */
export async function prepareDesktopProfile(root, home) {
  if (!home) throw new Error('Desktop launch requires an explicit DSH_HOME')
  const anchor = join(root, 'apps/cli/package.json')
  const require = createRequire(anchor)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const dir = boot.resolveProfileDir('web', home)
  const presets = []
  const availableBundles = []
  for (const name of DESKTOP_BUNDLES) {
    try {
      const packageDir = boot.resolveBundleDir('ClawMaster', name, anchor, dir)
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if (DESKTOP_PLUGIN_VERSIONS[name] && manifest.version !== DESKTOP_PLUGIN_VERSIONS[name]) {
        throw new Error(`requires ${name}@${DESKTOP_PLUGIN_VERSIONS[name]}; installed ${manifest.version}`)
      }
      if (!manifest.dsh?.bundle?.patch) throw new Error(`bundle ${name} has no dsh.bundle.patch`)
      readFileSync(join(packageDir, manifest.dsh.bundle.patch))
      if (manifest.main || manifest.exports?.['.']) require.resolve(name)
      if (manifest.dsh.client) require.resolve(`${name}/client`)
      for (const preset of manifest.dsh.desktop?.presets ?? []) {
        if (!/^[a-zA-Z0-9_-]+$/.test(preset.id) || typeof preset.path !== 'string') throw new Error(`invalid desktop preset metadata in ${name}`)
        const source = resolve(packageDir, preset.path)
        const path = relative(packageDir, source)
        if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`desktop preset path escapes ${name}`)
        readFileSync(join(source, 'preset.yml'))
        readFileSync(join(source, 'agent.cordis.yml'))
        presets.push({ source, destination: join(home, '.agent-presets', preset.id) })
      }
      availableBundles.push(name)
    } catch (error) {
      if (!DESKTOP_OPTIONAL_BUNDLES.includes(name)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ClawMaster: optional component ${name} is unavailable and was skipped: ${reason}\n`)
    }
  }
  const template = boot.PROFILE_TEMPLATES.web
  boot.initProfile(dir, template.bundles, template.patchReload)
  const before = boot.readProfileManifest('ClawMaster', dir)
  const userPatches = [dir, home].flatMap(path => boot.loadOptionalPatches('ClawMaster', join(path, 'cordis.patch.yml')) ?? [])
  const existingLayers = (before.dsh?.profile?.bundles ?? []).filter(name => name !== DESKTOP_UPDATES_BUNDLE
    && (!DESKTOP_OPTIONAL_BUNDLES.includes(name) || availableBundles.includes(name)))
    .flatMap(name => {
      const path = boot.resolveBundleDir('ClawMaster', name, anchor, dir)
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
      return boot.loadOverlayPatches('ClawMaster', join(path, manifest.dsh.bundle.patch))
    })
  const isUpdater = entry => entry.id === 'clawmaster-update-component-updates' || entry.name === '@clawmaster/dsh-updates'
    || (entry.group && Array.isArray(entry.config) && entry.config.some(isUpdater))
  const existingUpdater = [...existingLayers, ...userPatches].some(patch => patch.insert?.some(isUpdater))
  const after = withDesktopBundles(before, existingUpdater, availableBundles)
  if (JSON.stringify(before) !== JSON.stringify(after)) boot.writeProfileManifest(dir, after)
  for (const preset of presets) copyMissingPreset(preset.source, preset.destination)
  const imWorkspace = join(home, 'watchdog-workspaces', 'im')
  mkdirSync(imWorkspace, { recursive: true, mode: 0o700 })
  if (!lstatSync(imWorkspace).isDirectory()) throw new Error(`Desktop IM workspace is not a directory: ${imWorkspace}`)
}

// The packaged copy is a Node preload beside apps/, not an application launcher.
if (process.env.DSH_DESKTOP_DEFAULTS === '1') {
  delete process.env.DSH_DESKTOP_DEFAULTS
  const root = resolve(dirname(process.argv[1]), '../../..')
  await prepareDesktopProfile(root, process.env.DSH_HOME)
}
