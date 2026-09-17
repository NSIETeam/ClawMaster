/**
 * Production client composition without the page: mount the Loader over a
 * module system, activate required rows, audit them, and start optional rows
 * without waiting for their activation. `AppWebEntry` and the whole-client
 * test carrier both call it.
 * @module @deepseek-ai/dsh-client-web/src/boot-client
 */
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { BootManifest, ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { FIBER_STATE, STATE_LABELS } from './loader-status.ts'

/** Entry state label as the boot page renders it. */
export type EntryStateLabel = (typeof STATE_LABELS)[keyof typeof STATE_LABELS] | 'loading' | 'failed'

/** Inputs of {@link bootClient}. */
export interface ClientBootOptions {
  /** Fresh root Context that will own the plugin tree. */
  readonly ctx: Context
  /** Module system installed as `loader.internal`. */
  readonly modules: ClientModuleLoader
  /** Parsed manifest whose `plugins` rows become Loader entries (entry name = row id). */
  readonly manifest: BootManifest
  /** Per-entry state reporting (the boot page); omitted when no one renders progress. */
  readonly onEntryState?: (name: string, state: EntryStateLabel) => void
}

/**
 * Compose the client: activate and audit required rows before returning, then
 * start optional rows in the background. A required row whose module cannot be
 * imported rejects `loader.create`, so that import error propagates from here.
 * @param options - context, module system, manifest, optional progress sink.
 * @returns resolves after every entry is active; rejects with the audit report otherwise.
 */
export async function bootClient(options: ClientBootOptions): Promise<void> {
  const { ctx, manifest, onEntryState } = options
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.internal = options.modules as never

  ctx.on('internal/status', (fiber) => {
    const entry = fiber.entry
    if (entry === undefined || entry.fiber === undefined) return
    onEntryState?.(entry.options.name, STATE_LABELS[entry.fiber.state])
  })

  const requiredRows = manifest.plugins.filter(row => !row.optional)
  await Promise.all(requiredRows.map(async ({ id: name }) => {
    onEntryState?.(name, 'loading')
    const id = await loader.create({ name })
    if (loader.resolve(id).fiber === undefined) onEntryState?.(name, 'failed')
  }))
  await loader.await()
  assertEntriesActive(ctx)
  void activateOptionalRows(loader, manifest.plugins.filter(row => row.optional), onEntryState)
}

/** Activate optional rows after required services are ready without holding page startup open. */
async function activateOptionalRows(
  loader: Context['loader'],
  rows: BootManifest['plugins'],
  onEntryState: ClientBootOptions['onEntryState'],
): Promise<void> {
  await Promise.all(rows.map(async ({ id }) => {
    onEntryState?.(id, 'loading')
    try {
      await loader.create({ name: id })
    } catch (error) {
      const entry = Array.from(loader.entries()).find(item => item.options.name === id)
      if (entry) await loader.remove(entry.id)
      onEntryState?.(id, 'failed')
      console.error(`web boot: optional client component ${id} could not be loaded`, error)
    }
  }))
  try { await loader.await() } catch { /* Optional rows are removed and reported below. */ }
  for (const { id } of rows) {
    const entry = Array.from(loader.entries()).find(item => item.options.name === id)
    if (entry && (entry.fiber === undefined || entry.fiber.state !== FIBER_STATE.ACTIVE)) {
      await loader.remove(entry.id)
      onEntryState?.(id, 'failed')
      console.error(`web boot: optional client component ${id} did not activate and was disabled`)
    }
  }
}

/**
 * Reject entries that failed import/apply or still wait on missing services.
 * @param ctx - root Context carrying the Loader.
 * @throws {Error} listing every non-active entry with its reason.
 */
export function assertEntriesActive(ctx: Context): void {
  const failures: string[] = []
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    if (entry.fiber === undefined) {
      failures.push(`${name}: import failed (see console for the import error)`)
      continue
    }
    const state = STATE_LABELS[entry.fiber.state]
    if (state === 'active') continue
    if (state === 'pending') {
      const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
      failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
    } else {
      failures.push(`${name}: ${state}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
  }
}
