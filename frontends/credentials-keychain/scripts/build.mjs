import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  packages: 'external',
  external: ['@deepseek-ai/dsh-credentials-local'],
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  write: false,
})
if (process.argv.includes('--check')) {
  for (const output of result.outputFiles) {
    const current = await readFile(output.path).catch(() => undefined)
    if (current === undefined || !current.equals(output.contents)) throw new Error(`Credential provider build is stale: ${output.path}`)
  }
} else {
  await mkdir(join(root, 'dist'), { recursive: true })
  for (const output of result.outputFiles) await writeFile(output.path, output.contents)
}
