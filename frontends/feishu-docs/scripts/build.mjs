/** Bundle the Feishu document host half with the shared DSH ModuleLoader contract. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const digest = contents => createHash('sha256').update(contents).digest('hex');

// Host half only: this capability has no UI surface, so no client bundle is built.
// Workspace packages stay external because the DSH profile resolves them.
const host = await build({
  absWorkingDir: root, bundle: true, target: 'es2022', write: false, legalComments: 'inline',
  entryPoints: ['src/host.ts'], outfile: 'dist/index.js',
  packages: 'external', platform: 'node', format: 'esm',
});

const outputs = host.outputFiles;
if (process.argv.includes('--check')) {
  for (const output of outputs) {
    const current = await readFile(output.path).catch(() => undefined);
    if (current === undefined || digest(current) !== digest(output.contents)) {
      throw new Error(`Feishu docs build is stale: ${output.path}`);
    }
  }
  console.log('Feishu docs host build matches its sources.');
} else {
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const output of outputs) await writeFile(output.path, output.contents);
  console.log(`Built ${manifest.name}: read-only Feishu document tools.`);
}
