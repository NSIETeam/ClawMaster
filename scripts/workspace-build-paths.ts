/** Workspace discovery for the Host and Client bundle passes. */
import { globSync } from 'node:fs'
import { posix } from 'node:path'

/**
 * Find source package directories as forward-slash glob patterns on every host.
 * @param client Whether to select the Client bundle pass.
 * @param root Repository directory containing the workspace manifests.
 * @returns Sorted repository-relative package directory patterns.
 */
export function workspacePackages(client: boolean, root: string): string[] {
  const manifests = client
    ? ['vendor/*/package.json', 'packages/*/*/package.json', 'apps/cli/package.json']
    : ['vendor/*/package.json', 'packages/*/*/package.json', 'apps/cli/package.json', 'apps/desktop/package.json', 'apps/desktop-host/package.json']
  return globSync(manifests, { cwd: root }).map(file => posix.dirname(file.replaceAll('\\', '/'))).sort()
}
