/** Bundle the Guard host half with the same external-package contract as the other frontends. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const digest = contents => createHash('sha256').update(contents).digest('hex');

const host = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  target: 'es2022',
  write: false,
  legalComments: 'inline',
  packages: 'external',
  platform: 'node',
  format: 'esm',
});

const outputs = host.outputFiles;
if (process.argv.includes('--check')) {
  for (const output of outputs) {
    const current = await readFile(output.path).catch(() => undefined);
    if (current === undefined || digest(current) !== digest(output.contents)) {
      throw new Error(`Guard build is stale: ${output.path}`);
    }
  }
  console.log('Guard host build matches its sources.');
} else {
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const output of outputs) await writeFile(output.path, output.contents);
  console.log(`Built ${manifest.name}: pre-execute review of destructive tool calls.`);
}
