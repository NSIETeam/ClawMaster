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
  '@clawmaster/dsh-credentials-keychain',
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

/** Count ids in the shared EntryTree store, including child rows from every group. */
function loaderIdCounts(entries) {
  const counts = new Map()
  for (const entry of entries) {
    if (typeof entry.id === 'string') counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
    if (entry.group && Array.isArray(entry.config)) {
      for (const [childId, count] of loaderIdCounts(entry.config)) {
        counts.set(childId, (counts.get(childId) ?? 0) + count)
      }
    }
  }
  return counts
}

/** Reject optional patch inserts that the Loader cannot treat as entry rows. */
function validateOptionalInserts(name, patches) {
  const visit = (rows, label) => {
    if (!Array.isArray(rows)) throw new Error(`${name} ${label} must be an array of Loader entries`)
    for (const [index, row] of rows.entries()) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new Error(`${name} ${label} entry ${index + 1} must be a Loader entry mapping`)
      }
      if (typeof row.name !== 'string' || row.name.length === 0) {
        throw new Error(`${name} ${label} entry ${index + 1} must have a non-empty plugin name`)
      }
      if (row.id !== undefined && typeof row.id !== 'string') {
        throw new Error(`${name} ${label} entry ${index + 1} id must be a string`)
      }
      if (row.group !== undefined && row.group !== null && typeof row.group !== 'boolean') {
        throw new Error(`${name} ${label} entry ${index + 1} group must be a boolean`)
      }
      if (row.group === true) {
        if (!Array.isArray(row.config)) throw new Error(`${name} ${label} group entry ${index + 1} config must be an array`)
        visit(row.config, `${label} group ${row.id ?? index + 1}`)
      }
    }
  }
  for (const [index, patch] of patches.entries()) {
    if (patch.insert !== undefined) visit(patch.insert, `patch ${index + 1} insert`)
  }
}

/** Reject malformed rows anywhere in a fully composed Loader entry tree. */
function validateLoaderRows(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} must be an array of Loader entries`)
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`${label} entry ${index + 1} must be a Loader entry mapping`)
    }
    if (row.id !== undefined && typeof row.id !== 'string') {
      throw new Error(`${label} entry ${index + 1} id must be a string when provided`)
    }
    if (typeof row.name !== 'string' || row.name.length === 0) {
      throw new Error(`${label} entry ${index + 1} must have a non-empty plugin name`)
    }
    if (row.group !== undefined && row.group !== null && typeof row.group !== 'boolean') {
      throw new Error(`${label} entry ${index + 1} group must be a boolean`)
    }
    if (row.group === true) validateLoaderRows(row.config, `${label} group ${row.id}`)
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
  const nextBundles = [
    ...bundles.filter(name => !DESKTOP_OPTIONAL_BUNDLES.includes(name) || available.has(name)),
    ...availableBundles.filter(name => DESKTOP_BUNDLES.includes(name) && !bundles.includes(name)),
  ].filter(name => !existingUpdater || name !== DESKTOP_UPDATES_BUNDLE)
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        optionalClientPackages: [...DESKTOP_OPTIONAL_BUNDLES],
        bundles: nextBundles,
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
  const patchesByBundle = new Map()
  const availableBundles = []
  for (const name of DESKTOP_BUNDLES) {
    try {
      const packageDir = boot.resolveBundleDir('ClawMaster', name, anchor, dir)
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if (DESKTOP_PLUGIN_VERSIONS[name] && manifest.version !== DESKTOP_PLUGIN_VERSIONS[name]) {
        throw new Error(`requires ${name}@${DESKTOP_PLUGIN_VERSIONS[name]}; installed ${manifest.version}`)
      }
      if (!manifest.dsh?.bundle?.patch) throw new Error(`bundle ${name} has no dsh.bundle.patch`)
      const patchPath = join(packageDir, manifest.dsh.bundle.patch)
      readFileSync(patchPath)
      const patches = boot.loadOverlayPatches('ClawMaster', patchPath)
      if (DESKTOP_OPTIONAL_BUNDLES.includes(name)) validateOptionalInserts(name, patches)
      if (manifest.main || manifest.exports?.['.']) require.resolve(name)
      if (manifest.dsh.client) require.resolve(`${name}/client`)
      const bundlePresets = []
      for (const preset of manifest.dsh.desktop?.presets ?? []) {
        if (!/^[a-zA-Z0-9_-]+$/.test(preset.id) || typeof preset.path !== 'string') throw new Error(`invalid desktop preset metadata in ${name}`)
        const source = resolve(packageDir, preset.path)
        const path = relative(packageDir, source)
        if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`desktop preset path escapes ${name}`)
        readFileSync(join(source, 'preset.yml'))
        readFileSync(join(source, 'agent.cordis.yml'))
        bundlePresets.push({ name, source, destination: join(home, '.agent-presets', preset.id) })
      }
      presets.push(...bundlePresets)
      patchesByBundle.set(name, patches)
      availableBundles.push(name)
    } catch (error) {
      if (!DESKTOP_OPTIONAL_BUNDLES.includes(name)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ClawMaster: optional component ${name} is unavailable and was skipped: ${reason}\n`)
    }
  }
  const preflightBundles = new Set(availableBundles)
  const template = boot.PROFILE_TEMPLATES.web
  boot.initProfile(dir, template.bundles, template.patchReload)
  const before = boot.readProfileManifest('ClawMaster', dir)
  const userPatches = [dir, home].flatMap(path => boot.loadOptionalPatches('ClawMaster', join(path, 'cordis.patch.yml')) ?? [])
  const layerCache = new Map()
  const loadBundleLayer = name => {
    if (layerCache.has(name)) return layerCache.get(name)
    const cached = patchesByBundle.get(name)
    if (cached) {
      layerCache.set(name, cached)
      return cached
    }
    const packageDir = boot.resolveBundleDir('ClawMaster', name, anchor, dir)
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const patches = boot.loadOverlayPatches('ClawMaster', join(packageDir, manifest.dsh.bundle.patch))
    layerCache.set(name, patches)
    return patches
  }
  const isUpdater = entry => entry.id === 'clawmaster-update-component-updates' || entry.name === '@clawmaster/dsh-updates'
    || (entry.group && Array.isArray(entry.config) && entry.config.some(isUpdater))
  const requiredExistingLayers = (before.dsh?.profile?.bundles ?? []).filter(name => name !== DESKTOP_UPDATES_BUNDLE
    && !DESKTOP_OPTIONAL_BUNDLES.includes(name))
    .flatMap(loadBundleLayer)
  const requiredUpdater = [...requiredExistingLayers, ...userPatches].some(patch => patch.insert?.some(isUpdater))
  const planned = withDesktopBundles(before, requiredUpdater, availableBundles).dsh.profile.bundles
  const acceptedOptional = new Set()
  const composedLayers = includedOptional => [
    ...planned.flatMap(name => DESKTOP_OPTIONAL_BUNDLES.includes(name)
      ? includedOptional.has(name) ? [loadBundleLayer(name)] : []
      : [loadBundleLayer(name)]),
    ...userPatches,
  ]
  for (const name of planned) {
    if (!DESKTOP_OPTIONAL_BUNDLES.includes(name)) continue
    const baselineEntries = boot.composeEntries(composedLayers(acceptedOptional))
    validateLoaderRows(baselineEntries, 'Required Loader composition')
    const baselineCounts = loaderIdCounts(baselineEntries)
    const candidateOptional = new Set(acceptedOptional).add(name)
    let candidateEntries
    try {
      candidateEntries = boot.composeEntries(composedLayers(candidateOptional))
      validateLoaderRows(candidateEntries, `Optional component ${name} Loader composition`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ClawMaster: optional component ${name} has an invalid Loader composition and was skipped: ${reason}\n`)
      availableBundles.splice(availableBundles.indexOf(name), 1)
      patchesByBundle.delete(name)
      continue
    }
    const candidateCounts = loaderIdCounts(candidateEntries)
    const duplicateIds = [...candidateCounts]
      .filter(([id, count]) => count > 1 && count > (baselineCounts.get(id) ?? 0))
      .map(([id]) => id)
    if (duplicateIds.length > 0) {
      process.stderr.write(`ClawMaster: optional component ${name} has duplicate Loader id(s) and was skipped: ${duplicateIds.join(', ')}\n`)
      availableBundles.splice(availableBundles.indexOf(name), 1)
      patchesByBundle.delete(name)
      continue
    }
    acceptedOptional.add(name)
  }
  const activePresets = presets.filter(preset => !DESKTOP_OPTIONAL_BUNDLES.includes(preset.name)
    || acceptedOptional.has(preset.name))
  const presetOwners = new Map()
  const conflictingBundles = new Set()
  for (const preset of activePresets) {
    const previous = presetOwners.get(preset.destination)
    if (previous) {
      const optionalOwners = [previous.name, preset.name].filter(owner => DESKTOP_OPTIONAL_BUNDLES.includes(owner))
      if (optionalOwners.length === 0) throw new Error(`Desktop preset destination is declared more than once: ${preset.destination}`)
      for (const owner of optionalOwners) conflictingBundles.add(owner)
    } else {
      presetOwners.set(preset.destination, preset)
    }
  }
  for (const name of conflictingBundles) {
    process.stderr.write(`ClawMaster: optional component ${name} was skipped because its preset destination conflicts with another component\n`)
    const bundleIndex = availableBundles.indexOf(name)
    if (bundleIndex !== -1) availableBundles.splice(bundleIndex, 1)
    acceptedOptional.delete(name)
    patchesByBundle.delete(name)
  }
  const usablePresets = activePresets.filter(preset => !conflictingBundles.has(preset.name))
  for (const name of [...availableBundles]) {
    try {
      for (const preset of usablePresets.filter(item => item.name === name)) {
        validatePresetTarget(preset.source, preset.destination)
      }
      for (const preset of usablePresets.filter(item => item.name === name)) copyMissingPreset(preset.source, preset.destination)
    } catch (error) {
      if (!DESKTOP_OPTIONAL_BUNDLES.includes(name)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ClawMaster: optional component ${name} preset is unavailable and was skipped: ${reason}\n`)
      availableBundles.splice(availableBundles.indexOf(name), 1)
      acceptedOptional.delete(name)
      patchesByBundle.delete(name)
    }
  }
  if (availableBundles.includes('@xmanrui/dsh-im')) {
    const imWorkspace = join(home, 'watchdog-workspaces', 'im')
    try {
      mkdirSync(imWorkspace, { recursive: true, mode: 0o700 })
      if (!lstatSync(imWorkspace).isDirectory()) throw new Error(`Desktop IM workspace is not a directory: ${imWorkspace}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ClawMaster: optional component @xmanrui/dsh-im was skipped because its workspace is unavailable: ${reason}\n`)
      availableBundles.splice(availableBundles.indexOf('@xmanrui/dsh-im'), 1)
      acceptedOptional.delete('@xmanrui/dsh-im')
      patchesByBundle.delete('@xmanrui/dsh-im')
    }
  }
  if (!requiredUpdater && !availableBundles.includes(DESKTOP_UPDATES_BUNDLE)
    && preflightBundles.has(DESKTOP_UPDATES_BUNDLE)) {
    try {
      const baselineEntries = boot.composeEntries(composedLayers(acceptedOptional))
      validateLoaderRows(baselineEntries, 'Required Loader composition')
      const baselineCounts = loaderIdCounts(baselineEntries)
      const candidateOptional = new Set(acceptedOptional).add(DESKTOP_UPDATES_BUNDLE)
      const candidateEntries = boot.composeEntries(composedLayers(candidateOptional))
      validateLoaderRows(candidateEntries, 'Optional component @clawmaster/dsh-updates Loader composition')
      const duplicateIds = [...loaderIdCounts(candidateEntries)]
        .filter(([id, count]) => count > 1 && count > (baselineCounts.get(id) ?? 0))
        .map(([id]) => id)
      if (duplicateIds.length > 0) throw new Error(`duplicate Loader id(s): ${duplicateIds.join(', ')}`)
      availableBundles.push(DESKTOP_UPDATES_BUNDLE)
      acceptedOptional.add(DESKTOP_UPDATES_BUNDLE)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ClawMaster: optional component ${DESKTOP_UPDATES_BUNDLE} remains unavailable after other components were excluded: ${reason}\n`)
    }
  }
  const retainedOptionalLayers = availableBundles.filter(name => name !== DESKTOP_UPDATES_BUNDLE
    && DESKTOP_OPTIONAL_BUNDLES.includes(name)
    && acceptedOptional.has(name)).flatMap(loadBundleLayer)
  const updaterOwned = [...requiredExistingLayers, ...retainedOptionalLayers, ...userPatches]
    .some(patch => patch.insert?.some(isUpdater))
  const after = withDesktopBundles(before, updaterOwned, availableBundles)
  if (JSON.stringify(before) !== JSON.stringify(after)) boot.writeProfileManifest(dir, after)
}

/** Check every preset destination before copying any files from its component. */
function validatePresetTarget(source, destination) {
  const destinationStat = (() => {
    try { return lstatSync(destination) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  })()
  if (destinationStat && !destinationStat.isDirectory()) throw new Error(`Desktop preset directory is not a directory: ${destination}`)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const target = join(destination, entry.name)
    if (entry.isDirectory()) validatePresetTarget(join(source, entry.name), target)
    else if (entry.isFile()) {
      let targetStat
      try { targetStat = lstatSync(target) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (targetStat.isSymbolicLink() || (!targetStat.isFile() && !targetStat.isDirectory())) {
        throw new Error(`Desktop preset target has an unsupported file type: ${target}`)
      }
      if (targetStat.isDirectory()) throw new Error(`Desktop preset file conflicts with a directory: ${target}`)
    } else throw new Error(`Desktop preset source must contain only files and directories: ${entry.name}`)
  }
}

// The packaged copy is a Node preload beside apps/, not an application launcher.
if (process.env.DSH_DESKTOP_DEFAULTS === '1') {
  delete process.env.DSH_DESKTOP_DEFAULTS
  const root = resolve(dirname(process.argv[1]), '../../..')
  await prepareDesktopProfile(root, process.env.DSH_HOME)
}
