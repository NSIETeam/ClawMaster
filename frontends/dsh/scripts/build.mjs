import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(path.join(root, 'dist'), { recursive: true });
// Official DSH ModuleLoader supplies the same React singleton as other plugins.
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client.tsx'],
  outfile: 'dist/client.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.png': 'dataurl', '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory(require) { const module = { exports: {} }; const exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  metafile: true,
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/host.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
});
await writeFile(path.join(root, 'dist/build-meta.json'), JSON.stringify(result.metafile, null, 2) + '\n');
console.log(`Built ${manifest.name}: WatchDog client factory + managed Workspace host registration.`);
