/** Build-time verification shared by explicit preparation and offline builds. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANIFEST = '.clawmaster-office-manifest.json';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Independent frontend installs must not borrow paths from a developer's dependency tree. */
export function assertPortableNpmLock(lock) {
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path.startsWith('../') || entry.link === true || (entry.resolved !== undefined && !/^https:\/\//.test(entry.resolved))) {
      throw new Error(`Office dependency lock contains a local installation reference: ${path}`);
    }
  }
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function tree(root, relative = '') {
  const files = {};
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await tree(root, name));
    else if (!entry.isFile()) throw new Error(`Office resources must be regular files: ${name}`);
    else if (name !== MANIFEST) files[name] = await hashFile(join(root, name));
  }
  return files;
}
export async function verify(root, source) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Office runtime must be a real directory.');
  const bytes = await readFile(join(root, MANIFEST));
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !manifest.files || !manifest.files['index.html']) throw new Error('Invalid Office runtime manifest.');
  for (const key of ['repository', 'commit', 'releaseTag', 'archiveUrl', 'archiveSha256']) {
    if (manifest.upstream?.[key] !== source[key]) throw new Error(`Office upstream pin differs: ${key}`);
  }
  const actual = await tree(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Office resource bytes differ. Run prepare-runtime, then rebuild.');
  return digest(bytes);
}
