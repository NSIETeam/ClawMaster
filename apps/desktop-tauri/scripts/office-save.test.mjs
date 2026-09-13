/** Protected binary upload behavior against the pinned sidebar source and emitted revision parser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const provenance = JSON.parse(await readFile(new URL('../patches/dsh-better-sidebar@0.19.1.office-save.provenance.json', import.meta.url)));
const patch = fileURLToPath(new URL('../patches/dsh-better-sidebar@0.19.1.office-save.patch', import.meta.url));
const root = process.env.DSH_OFFICE_SIDEBAR_PACKAGE_ROOT;
assert.ok(root, 'Set DSH_OFFICE_SIDEBAR_PACKAGE_ROOT to the unpacked pinned sidebar package.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const revision = value => `sha256-${sha(Buffer.from(value))}`;
assert.equal(sha(await readFile(patch)), provenance.patchSha256);
const packageRoot = resolve(root);
const actual = sha(await readFile(join(packageRoot, 'src/fs-operations.ts')));
const patched = actual === provenance.patchedSha256['src/fs-operations.ts'];
assert.ok(patched || actual === provenance.inputSha256['src/fs-operations.ts']);
const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-office-save-'));
test.after(() => rm(temporary, { recursive: true, force: true }));
const fixturePackage = join(temporary, 'package');
await cp(packageRoot, fixturePackage, { recursive: true });
if (!patched) {
  const result = spawnSync('git', ['apply', patch], { cwd: fixturePackage, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
}
for (const [file, hash] of Object.entries(provenance.patchedSha256)) assert.equal(sha(await readFile(join(fixturePackage, file))), hash, file);
const { writeWorkspaceUpload } = await import(pathToFileURL(join(fixturePackage, 'src/fs-operations.ts')).href);
const upload = (cwd, content, expectedRevision, extra = {}) => writeWorkspaceUpload({ cwd, dir: cwd, relativePath: 'document.docx', chunks: (async function* () { yield Buffer.from(content); })(), limit: 1024, expectedRevision, ...extra });
async function workspace(t) {
  const root = await mkdtemp(join(temporary, 'workspace-'));
  await writeFile(join(root, 'document.docx'), 'original');
  t.after(async () => assert.deepEqual(await readdir(root), ['document.docx']));
  return root;
}
test('confirmed upload returns new revision; stale targets conflict without replacement', async t => {
  const cwd = await workspace(t);
  const result = await upload(cwd, 'edited', revision('original'));
  assert.deepEqual(result, { path: join(cwd, 'document.docx'), size: 6, revision: revision('edited') });
  await assert.rejects(upload(cwd, 'stale', revision('original')), error => error.status === 412);
  assert.equal(await readFile(join(cwd, 'document.docx'), 'utf8'), 'edited');
});
test('a deleted file is not silently recreated by an old editor', async () => {
  const cwd = await mkdtemp(join(temporary, 'deleted-'));
  await assert.rejects(upload(cwd, 'edited', revision('original')), error => error.status === 412);
  assert.deepEqual(await readdir(cwd), []);
});
test('same-revision concurrent uploads produce one save and one conflict', async t => {
  const cwd = await workspace(t);
  const results = await Promise.allSettled([upload(cwd, 'first', revision('original')), upload(cwd, 'second', revision('original'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 412);
  assert.ok(['first', 'second'].includes(await readFile(join(cwd, 'document.docx'), 'utf8')));
});
test('an external change during the body stream is checked before the final rename', async t => {
  const cwd = await workspace(t);
  const chunks = (async function* () { yield Buffer.from('proposed'); await writeFile(join(cwd, 'document.docx'), 'external edit'); })();
  await assert.rejects(upload(cwd, '', revision('original'), { chunks }), error => error.status === 412);
  assert.equal(await readFile(join(cwd, 'document.docx'), 'utf8'), 'external edit');
});
test('oversized or aborted uploads preserve the target and remove temporary siblings', async t => {
  const cwd = await workspace(t);
  await assert.rejects(upload(cwd, 'too many bytes', revision('original'), { limit: 3 }), error => error.status === 413);
  const chunks = (async function* () { yield Buffer.from('partial'); throw new Error('body aborted'); })();
  await assert.rejects(upload(cwd, '', revision('original'), { chunks }), /body aborted/);
  assert.equal(await readFile(join(cwd, 'document.docx'), 'utf8'), 'original');
});
test('unversioned upload retains the legacy response and rejects traversal', async t => {
  const cwd = await workspace(t);
  assert.deepEqual(await upload(cwd, 'legacy'), { path: join(cwd, 'document.docx'), size: 6 });
  await assert.rejects(upload(cwd, 'escape', undefined, { relativePath: '../escape.docx' }));
});
test('the emitted HTTP parser rejects weak, wildcard, list and malformed If-Match tags', async () => {
  const source = await readFile(join(fixturePackage, 'lib/index.js'), 'utf8');
  const match = source.match(/function uploadRevisionHeader\(header\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  const parse = runInNewContext(`${match[0]}; uploadRevisionHeader`, { SidebarError: class extends Error {} });
  assert.equal(parse(undefined), undefined);
  assert.equal(parse(`"${revision('original')}"`), revision('original'));
  for (const value of ['*', `W/"${revision('original')}"`, `${revision('original')}`, '"sha256-ABC"', ['"sha256-a"'], `"${revision('a')}", "${revision('b')}"`]) assert.throws(() => parse(value));
  assert.match(source, /expectedRevision = uploadRevisionHeader\(req.headers\['if-match'\]\)/);
});
