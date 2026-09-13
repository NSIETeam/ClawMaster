/** Explicit network preparation for the immutable, hash-pinned ONLYOFFICE release. */
import { unzipSync } from 'fflate';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, mkdtemp, rename, rm, cp, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, assertPortableNpmLock, digest, tree, verify } from './runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
assertPortableNpmLock(JSON.parse(await readFile(join(root, 'package-lock.json'))));
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const output = resolve(option('--output') ?? join(root, 'runtime'));
const source = JSON.parse(await readFile(join(root, 'vendor/onlyoffice-web-local/SOURCE.json')));
if (digest(await readFile(join(root, 'vendor/onlyoffice-web-local/x2t.ts'))) !== source.patchedSourceSha256) throw new Error('Modified Office converter differs from its provenance.');
await mkdir(dirname(output), { recursive: true });
const temporary = await mkdtemp(join(dirname(output), '.office-prepare-'));
try {
  let archive;
  if (option('--archive')) archive = await readFile(resolve(option('--archive')));
  else {
    const response = await fetch(source.archiveUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Office release download failed: ${response.status}`);
    archive = new Uint8Array(await response.arrayBuffer());
  }
  if (digest(archive) !== source.archiveSha256) throw new Error('Office release SHA-256 mismatch.');
  const extracted = unzipSync(archive, { filter: entry => /^html\/(web-apps|sdkjs|fonts|wasm|img)\//.test(entry.name) && !entry.name.endsWith('.gz') });
  for (const [name, bytes] of Object.entries(extracted)) {
    const relative = name.slice('html/'.length);
    if (name.endsWith('/')) continue;
    if (/[\\%?#:\x00-\x1f]/.test(relative) || relative.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('Invalid Office archive path.');
    await mkdir(dirname(join(temporary, relative)), { recursive: true });
    await writeFile(join(temporary, relative), bytes, { flag: 'wx' });
  }
  await cp(join(root, 'src/frame.html'), join(temporary, 'index.html'));
  await build({ absWorkingDir: root, entryPoints: ['src/frame.ts'], outfile: join(temporary, 'frame.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'inline' });
  await cp(join(root, 'LICENSE'), join(temporary, 'LICENSE.txt'));
  await cp(join(root, 'vendor/onlyoffice-web-local'), join(temporary, 'source/onlyoffice-web-local'), { recursive: true });
  await cp(join(root, 'patches'), join(temporary, 'source/patches'), { recursive: true });
  await cp(join(root, 'src'), join(temporary, 'source/adapter'), { recursive: true });
  await cp(join(root, 'scripts'), join(temporary, 'source/scripts'), { recursive: true });
  await cp(join(root, 'package.json'), join(temporary, 'source/package.json'));
  await cp(join(root, 'package-lock.json'), join(temporary, 'source/package-lock.json'));
  await writeFile(join(temporary, 'NOTICE.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>ONLYOFFICE license and source</title><body><h1>ONLYOFFICE</h1><p>Copyright Ascensio System SIA and contributors. This local editor includes onlyoffice-web-local release-8, licensed under GNU AGPL v3. ONLYOFFICE logos and legal notices are retained.</p><p><a href="LICENSE.txt">License</a> · <a href="https://github.com/sweetwisdom/onlyoffice-web-local/tree/' + source.commit + '">Pinned upstream source</a> · <a href="source/onlyoffice-web-local/x2t.ts">Modified converter source</a> · <a href="source/adapter/frame.ts">Local integration source</a> · <a href="source/patches/onlyoffice-x2t.patch">Converter changes</a></p></body></html>\n');
  const upstream = Object.fromEntries(['repository', 'commit', 'releaseTag', 'archiveUrl', 'archiveSha256'].map(key => [key, source[key]]));
  await writeFile(join(temporary, MANIFEST), JSON.stringify({ schemaVersion: 1, upstream, files: await tree(temporary) }, null, 2) + '\n');
  await verify(temporary, source);
  let exists = false;
  try { await access(output); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    await verify(output, source);
    const backup = `${temporary}-previous`;
    await rename(output, backup);
    try { await rename(temporary, output); } catch (error) { await rename(backup, output); throw error; }
    await rm(backup, { recursive: true });
  } else await rename(temporary, output);
  console.log(`Prepared verified Office runtime at ${output}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
