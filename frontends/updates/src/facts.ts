/** Read current-process facts without treating an older desktop manifest as active. */
import { lstat, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { valid } from 'semver'
import type { NativeTarget } from './native.ts'

/** Identity of this Host, captured from the executing process rather than remembered metadata. */
export interface HostIdentity {
  pid: number
  runId: string | undefined
  entry: string | undefined
  platform: NodeJS.Platform
  arch: string
  appImage: boolean
  statePath?: string
}

/** Observed versions; null means that this Host cannot establish the value. */
export interface RuntimeFacts {
  observedAt: string
  hostPid: number
  runId: string | null
  source: 'desktop-runtime' | 'dsh-package' | 'unavailable'
  dshVersion: string | null
  desktopVersion: string | null
  nativeTarget: NativeTarget | null
  providedPackages: Record<string, string>
}

async function record(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return undefined
    const bytes = await readFile(path)
    if (bytes.length > 1024 * 1024) return undefined
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function version(value: unknown): string | null { return typeof value === 'string' && valid(value) === value ? value : null }

async function entryPackage(entry: string | undefined): Promise<string | null> {
  if (!entry || !isAbsolute(entry)) return null
  let directory = dirname(entry)
  while (true) {
    const value = await record(join(directory, 'package.json'))
    if (value?.name === '@deepseek-ai/dsh') return version(value.version)
    if (directory === parse(directory).root) return null
    directory = dirname(directory)
  }
}

async function sharedPackages(entry: string | undefined): Promise<Record<string, string>> {
  if (!entry || !isAbsolute(entry)) return {}
  const require = createRequire(entry)
  const packages: Record<string, string> = {}
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-user-approval']) {
    let path: string
    try { path = require.resolve(`${name}/package.json`) }
    catch (error) { if (['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error }
    const value = await record(path)
    const installed = version(value?.version)
    if (value?.name === name && installed) packages[name] = installed
  }
  return packages
}

function nativeTarget(identity: HostIdentity): NativeTarget | null {
  if (identity.platform === 'darwin') return identity.arch === 'arm64' ? 'darwin-aarch64' : identity.arch === 'x64' ? 'darwin-x86_64' : null
  if (identity.platform === 'win32' && identity.arch === 'x64') return 'windows-x86_64'
  if (identity.platform === 'linux' && identity.arch === 'x64' && identity.appImage) return 'linux-x86_64'
  return null
}

/** Inspect the selected home and the executing CLI; stale or stopped desktop records are ignored.
 * @param dshHome Absolute home selected by this Host's Loader.
 * @param identity Process identity; defaults to the actual executing Host.
 * @returns Versions supported by current-process evidence and available shared package versions.
 */
export async function readRuntimeFacts(dshHome: string, identity: HostIdentity = {
  pid: process.pid, runId: process.env.CLAWMASTER_RUNTIME_RUN_ID, entry: process.argv[1],
  platform: process.platform, arch: process.arch, appImage: !!process.env.APPIMAGE,
  ...(process.env.CLAWMASTER_RUNTIME_STATE ? { statePath: process.env.CLAWMASTER_RUNTIME_STATE } : {}),
}): Promise<RuntimeFacts> {
  const statePath = join(dshHome, 'desktop', 'current-runtime.json')
  if (identity.statePath !== undefined && identity.statePath !== statePath) throw new Error('Desktop runtime state path differs from the configured DSH home')
  const current = await record(statePath)
  const matched = current?.schemaVersion === 1 && current.status === 'ready' && current.hostPid === identity.pid
    && !!identity.runId && current.runId === identity.runId
  const cliVersion = await entryPackage(identity.entry)
  const manifestVersion = matched ? version(current.harnessVersion) : null
  const dshVersion = cliVersion ?? manifestVersion
  return {
    observedAt: new Date().toISOString(), hostPid: identity.pid, runId: identity.runId ?? null,
    source: matched && manifestVersion && dshVersion === manifestVersion ? 'desktop-runtime' : cliVersion ? 'dsh-package' : 'unavailable',
    dshVersion, desktopVersion: matched ? version(current.desktopVersion) : null,
    nativeTarget: nativeTarget(identity), providedPackages: await sharedPackages(identity.entry),
  }
}
