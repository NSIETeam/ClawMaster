/** Build the separate update kit without replacing the already published updater artifacts. */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = fileURLToPath(new URL('..', import.meta.url))
const external = ['@threema/wasm-minisign-verify']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Build or check only kit/dist/update-kit.mjs.
 * @param options Check mode and the selected updates source directory.
 * @returns The built artifact path and content digest.
 */
export async function buildKit({ check = false, root = defaultRoot } = {}) {
  const outputPath = join(root, 'kit/dist/update-kit.mjs')
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/update-kit.ts'], outfile: outputPath,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
    legalComments: 'inline', metafile: true, external,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path) && !external.includes(dependency.path)) throw new Error(`Unbundled kit dependency: ${dependency.path}`)
    }
  }
  const output = result.outputFiles[0]
  if (!output || result.outputFiles.length !== 1) throw new Error('Update kit build must produce one JavaScript entry')
  const sha256 = digest(output.contents)
  if (check) {
    if (digest(await readFile(outputPath)) !== sha256) throw new Error('Stale update kit artifact')
  } else {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, output.contents)
  }
  return { path: outputPath, sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(argument => argument !== '--check') || process.argv.slice(2).length > 1) throw new Error('Usage: build-kit.mjs [--check]')
    console.log(JSON.stringify(await buildKit({ check: process.argv.includes('--check') })))
  } catch (error) { console.error(error instanceof Error ? error.message : 'Update kit build failed'); process.exitCode = 1 }
}
