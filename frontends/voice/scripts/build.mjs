/** Bundle the Voice host half and client half with the shared DSH ModuleLoader contract. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const digest = contents => createHash('sha256').update(contents).digest('hex');

const common = { absWorkingDir: root, bundle: true, target: 'es2022', write: false, legalComments: 'inline' };

// Host half: Node ESM, workspace packages stay external (the profile resolves them).
// The optional native speech engine is external too: it is present at runtime only when the
// component's models and prebuilt binaries are installed, and its absence must not break the boot.
const host = await build({
  ...common, entryPoints: ['src/host.ts'], outfile: 'dist/index.js',
  packages: 'external', platform: 'node', format: 'esm',
});

// Client half: the official ModuleLoader supplies the same React singleton as other plugins.
const client = await build({
  ...common, entryPoints: ['src/client.tsx'], outfile: 'dist/client.js',
  platform: 'browser', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory(require) { const module = { exports: {} }; const exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
});

const outputs = [...host.outputFiles, ...client.outputFiles];
if (process.argv.includes('--check')) {
  for (const output of outputs) {
    const current = await readFile(output.path).catch(() => undefined);
    if (current === undefined || digest(current) !== digest(output.contents)) {
      throw new Error(`Voice build is stale: ${output.path}`);
    }
  }
  console.log('Voice host and client builds match their sources.');
} else {
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const output of outputs) await writeFile(output.path, output.contents);
  console.log(`Built ${manifest.name}: host routes and tools + sidebar voice tab.`);
}
