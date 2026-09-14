import { vi, describe, expect, it } from 'vitest'

vi.mock('node:fs', async original => ({
  ...await original<typeof import('node:fs')>(),
  globSync: vi.fn(() => ['packages\\core\\agent\\package.json', 'apps/cli/package.json']),
}))
import { workspacePackages } from './workspace-build-paths.ts'

describe('workspace bundle paths', () => {
  it.each([false, true])('passes forward-slash workspace globs to the bundler (client: %s)', (client) => {
    expect(workspacePackages(client, '/repo')).toEqual(['apps/cli', 'packages/core/agent'])
  })
})
