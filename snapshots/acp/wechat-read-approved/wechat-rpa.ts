/** Mount the production RPA tools with a scenario-owned synthetic helper. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { apply as mountRpa } from '../../../frontends/rpa/src/index.ts'

export { name, inject } from '../../../frontends/rpa/src/index.ts'

/**
 * Use the isolated profile home and synthetic helper without inspecting the desktop.
 * @param ctx The shipped profile's tool and approval services.
 */
export function apply(ctx: Context): void {
  const home = process.env.DSH_HOME
  if (!home) throw new Error('The WeChat snapshot requires an isolated DSH_HOME')
  mountRpa(ctx, {
    stateDir: join(home, 'rpa'),
    helper: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./synthetic-helper.mjs', import.meta.url))],
    },
  })
}
