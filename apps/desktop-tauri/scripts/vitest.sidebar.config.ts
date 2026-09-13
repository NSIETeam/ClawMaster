/** Source DSH sidebar composition with the exact installed Better Sidebar client artifacts. */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const webRequire = createRequire(`${root}apps/web/package.json`)
export default defineConfig({
  root,
  plugins: [tsconfigPaths({ projects: [`${root}tsconfig.base.json`], loose: true }), standardDecoratorPlugin()],
  resolve: {
    alias: [
      { find: /^react(\/.*)?$/, replacement: `${dirname(webRequire.resolve('react/package.json'))}$1` },
      { find: /^react-dom(\/.*)?$/, replacement: `${dirname(webRequire.resolve('react-dom/package.json'))}$1` },
    ],
  },
  test: {
    environment: 'jsdom', pool: 'forks', execArgv: vitestExecArgv,
    include: ['apps/desktop-tauri/scripts/better-sidebar-native.test.mjs'],
  },
})
