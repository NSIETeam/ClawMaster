/** Mount production update tools with isolated four-target metadata and Intel machine facts. */
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { apply as mountUpdates, type UpdatesHostContext } from '../../../frontends/updates/src/host.ts'

export { name, inject } from '../../../frontends/updates/src/host.ts'

/**
 * Confine updater writes to the snapshot workspace and reject every non-metadata request.
 * @param ctx The shipped ACP profile's command, tool and approval services.
 */
export async function apply(ctx: UpdatesHostContext): Promise<void> {
  const home = process.env.DSH_HOME
  if (process.env.DSH_SNAPSHOT !== 'replay' || !home || basename(home) !== '.dsh'
    || realpathSync(dirname(home)) !== realpathSync(process.cwd())) {
    throw new Error('The updater snapshot requires the isolated replay profile')
  }
  const manifestUrl = 'https://updates.invalid/updates/clawmaster/v2/latest.json'
  await mountUpdates(ctx, {
    dshHome: join(process.cwd(), 'updater-state'),
    nativeManifestUrl: manifestUrl,
    nativeTarget: 'darwin-x86_64',
    checkIntervalMs: 0,
    locale: 'en-US',
  }, {
    fetchImpl: async (url, init) => {
      init?.signal?.throwIfAborted()
      if (url !== manifestUrl) throw new Error('The snapshot forbids artifact downloads and external requests')
      return new Response(await readFile(new URL('./native-four-targets.json', import.meta.url), 'utf8'))
    },
    facts: async () => ({
      observedAt: '2026-09-15T00:00:00Z', hostPid: 42, runId: 'snapshot-host', source: 'desktop-runtime',
      dshVersion: '0.1.5-rc.2', desktopVersion: '0.2.1', nativeTarget: 'darwin-x86_64', providedPackages: {},
    }),
  })
}
