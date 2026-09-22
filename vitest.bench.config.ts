import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/**
 * CI performance gate. Node CPU cases use compiled plain-Node workers under
 * `benchmarks/.dsh-build/`; browser cases drive built Client artifacts through
 * the shared shipped-composition Web scaffold.
 * Files run one at a time so a measurement never shares the CPU with another
 * benchmark.
 */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    include: [
      'benchmarks/**/*.bench.ts',
      'benchmarks/**/*.bench.client.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 600_000,
    // Seeding scenarios (agent-continuation provisions two full source
    // workspaces per file) is setup cost, not a measured budget; on loaded
    // CI runners it legitimately exceeds the 2-minute default and fails the
    // gate before any benchmark runs.
    hookTimeout: 600_000,
    disableConsoleIntercept: true,
  },
})
