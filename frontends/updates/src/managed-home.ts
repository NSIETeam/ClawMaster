/** Reject redirected updater storage without creating directories during a read-only plan. */
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'

/** Check the selected home and updater-owned parent directories before any download.
 * @param dshHome Explicit DSH home, whose system ancestors are outside updater ownership.
 * @returns Resolves for absent or real directories; links and files are rejected.
 */
export async function assertManagedHome(dshHome: string): Promise<void> {
  if (!isAbsolute(dshHome) || resolve(dshHome) !== dshHome || parse(dshHome).root === dshHome) throw new Error('DSH home must be absolute, normalized and below the filesystem root')
  for (const path of [dshHome, join(dshHome, 'clawmaster-updates'), join(dshHome, 'clawmaster-updates', 'downloads')]) {
    try {
      const entry = await lstat(path)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Update home and managed directories must not be symbolic links')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
}
