/** Bundle the sidebar adapter without downloading or modifying the pinned editor resources. */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertPortableNpmLock, digest, verify } from './runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
assertPortableNpmLock(JSON.parse(await readFile(join(root, 'package-lock.json'))));
const source = JSON.parse(await readFile(join(root, 'vendor/onlyoffice-web-local/SOURCE.json')));
const runtimeHash = await verify(join(root, 'runtime'), source);
const frame = await build({ absWorkingDir: root, entryPoints: ['src/frame.ts'], outfile: 'frame.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'inline', write: false });
if (digest(frame.outputFiles[0].contents) !== digest(await readFile(join(root, 'runtime/frame.js')))
  || digest(await readFile(join(root, 'src/frame.html'))) !== digest(await readFile(join(root, 'runtime/index.html')))) {
  throw new Error('Office frame source changed. Run prepare-runtime before building.');
}
const manifest = JSON.parse(await readFile(join(root, 'package.json')));
const common = { absWorkingDir: root, bundle: true, target: 'es2022', write: false, legalComments: 'inline' };
const host = await build({ ...common, entryPoints: ['src/host.ts'], outfile: 'dist/index.js', packages: 'external', platform: 'node', format: 'esm', define: { __OFFICE_RUNTIME_MANIFEST_SHA256__: JSON.stringify(runtimeHash) } });
const client = await build({ ...common, entryPoints: ['src/client.tsx'], outfile: 'dist/client.js', platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'text' }, banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory(require) { const module = { exports: {} }; const exports = module.exports;` }, footer: { js: 'return module.exports; } });' } });
const outputs = [...host.outputFiles, ...client.outputFiles];
if (process.argv.includes('--check')) {
  for (const output of outputs) if (digest(await readFile(output.path)) !== digest(output.contents)) throw new Error(`Office build is stale: ${output.path}`);
  console.log('Office runtime and adapter build match their pinned inputs.');
} else {
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const output of outputs) await writeFile(output.path, output.contents);
  console.log(`Built ${manifest.name} with verified local Office resources.`);
}
