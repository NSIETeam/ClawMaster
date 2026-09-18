/** Prepare and explicitly confirm the updater's first mount into an existing DSH web profile. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { fetchCatalog } from './catalog.ts'
import { downloadVerifiedFile } from './download.ts'
import { installComponent, readComponentPatchRevision } from './components.ts'
import { bootstrapUpdater } from './bootstrap.ts'
import { COMPONENT_PUBLIC_KEY } from './keys.ts'
import { assertManagedHome } from './managed-home.ts'

/** Selected runtime and home; the finite utility never discovers or changes another home. */
export interface InstallerOptions {
  dshHome: string
  runtimeRoot: string
  confirmed: boolean
  expectedSha256?: string
  expectedPatchRevision?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** Explicit trust material for an embedding deployment; the command-line installer pins its own key. */
export interface InstallerTrust { catalogUrl: string; publicKeyPem: string }

const runtimeManifest = z.object({ name: z.literal('@deepseek-ai/dsh-root'), version: z.string() })
const cordisManifest = z.object({ name: z.literal('@deepseek-ai/cordis'), version: z.string() })

/** Verify the live channel and either display a first-install plan or mount its authenticated plugin.
 * @param options Explicit home, actual runtime root and one-shot confirmation.
 * @param trust Deployment trust anchor; omitted for the pinned production channel.
 * @returns Read-only plan or Loader-pending installation; an existing updater row is never replaced.
 */
export async function installUpdater(options: InstallerOptions, trust: InstallerTrust = { catalogUrl: 'https://8.140.52.117/updates/clawmaster/components/catalog.json', publicKeyPem: COMPONENT_PUBLIC_KEY }): Promise<Record<string, unknown>> {
  for (const path of [options.dshHome, options.runtimeRoot]) if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Installer paths must be absolute and normalized')
  await assertManagedHome(options.dshHome)
  const runtime = runtimeManifest.parse(JSON.parse(await readFile(join(options.runtimeRoot, 'package.json'), 'utf8')))
  const cordis = cordisManifest.parse(JSON.parse(await readFile(join(options.runtimeRoot, 'vendor/cordis/package.json'), 'utf8')))
  const request = { ...(options.signal ? { signal: options.signal } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }
  const catalog = await fetchCatalog({ ...request,
    ...trust, requestTimeoutMs: 30_000, maxCatalogBytes: 1024 * 1024, maxDownloadBytes: 64 * 1024 * 1024,
  })
  const item = catalog.components.find(item => item.id === 'updates')
  if (!item || item.kind !== 'component' || item.packageName !== '@clawmaster/dsh-updates' || item.activation !== 'restart') throw new Error('The channel has no compatible updater plugin')
  if (item.requiresDshVersion !== runtime.version) throw new Error('The updater requires a different DSH version')
  const expectedPatchRevision = await readComponentPatchRevision(options.dshHome)
  const plan = { status: 'confirmation-required', component: item.id, version: item.version, sha256: item.sha256, size: item.size, dshHome: options.dshHome, dshVersion: runtime.version, expectedPatchRevision }
  if (!options.confirmed) return plan
  if (options.expectedSha256 !== item.sha256 || options.expectedPatchRevision !== expectedPatchRevision) throw new Error('The confirmed installer plan differs; inspect a fresh plan before retrying')
  await assertManagedHome(options.dshHome)
  const file = await downloadVerifiedFile(item, { ...request, cacheDir: join(options.dshHome, 'clawmaster-updates', 'downloads'), downloadTimeoutMs: 600_000, maxDownloadBytes: 64 * 1024 * 1024 })
  await installComponent({ archivePath: file.path, descriptor: item, dshHome: options.dshHome, dshVersion: runtime.version, providedPackages: { [cordis.name]: cordis.version } })
  const activation = await bootstrapUpdater({ dshHome: options.dshHome, version: item.version, expectedPatchRevision, confirmed: true })
  return { ...plan, ...activation }
}
