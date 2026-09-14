/** Cross-platform policy checks use explicit paths without touching the host filesystem. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectShellCommand } from '../src/classify.ts';
import { pathUnder, normalizePath } from '../src/paths.ts';
import { DEFAULT_OPTIONS, reviewCall, workdirOf } from '../src/policy.ts';
import { resolvedUnder } from '../src/probe.ts';

const context = { home: 'C:\\Users\\Alice', cwd: 'C:\\work\\project', probe: () => [] };
const call = command => ({ name: 'bash', arguments: { command } });

it('denies Windows home, working tree, parent, drive and UNC root deletions', () => {
  for (const command of ['rm -rf ~', 'rm -rf $HOME', 'rm -rf .', 'rm -rf ..', "rm -rf 'C:/'", "rm -rf 'c:/users/ALICE/'", "rm -rf '//server/share/'"]) {
    assert.equal(reviewCall(call(command), DEFAULT_OPTIONS, context).decision?.kind, 'deny', command);
  }
});

it('resolves bounded relative and quoted Windows targets without duplicating the working directory', () => {
  for (const command of ["rm 'C:\\work\\project\\note.md'", 'rm note.md']) {
    const finding = inspectShellCommand(command, context);
    assert.deepEqual(finding.targets, ['C:/work/project/note.md']);
    assert.equal(finding.risk, 'high');
  }
  assert.equal(workdirOf({ arguments: { workdir: context.cwd } }), context.cwd);
});

it('denies protected Windows targets when inspection cannot read them', () => {
  const options = { ...DEFAULT_OPTIONS, denyPaths: ['C:\\work\\keep\\'] };
  assert.equal(reviewCall(call("rm 'c:/WORK/keep/note.md'"), options, context).decision?.kind, 'deny');
  assert.equal(reviewCall(call("rm 'C:/work/keeper/note.md'"), options, context).decision?.kind, 'ask');
});

it('matches Windows resolved prefixes and excludes unrelated drives and siblings', () => {
  const probe = { target: 'C:/scratch/link', realPath: 'D:\\Protected\\notes', exists: true, kind: 'directory', symlink: true };
  assert.equal(resolvedUnder(probe, ['d:/protected']), 'd:/protected');
  assert.equal(resolvedUnder(probe, ['C:/protected', 'D:/protected-other']), undefined);
  assert.equal(pathUnder('C:/work/file', 'C:\\'), true);
});

it('retains POSIX case and literal backslashes in directory names', () => {
  assert.equal(normalizePath('/work/a\\b/../keep'), '/work/keep');
  assert.equal(pathUnder('/work/a\\b/file', '/work/a'), false);
  assert.equal(pathUnder('/Work/keep/file', '/work/keep'), false);
  assert.equal(pathUnder('/work/keep/file', '/'), true);
  assert.equal(pathUnder('/work/file', ''), false);
});
