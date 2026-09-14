/** The read-only target inspection: what it reports, and what it is allowed to change. */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROBE_TARGETS, describeProbe, probeTargets, resolvedUnder } from '../src/probe.ts';
import { DEFAULT_OPTIONS, reviewCall } from '../src/policy.ts';

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

/** A scratch tree: one protected directory, one file, one link that reaches into the protected one. */
async function tree() {
  // Resolved once, so a platform that maps a temporary directory elsewhere (/var → /private/var on
  // macOS) cannot make an assertion about resolution pass or fail for the wrong reason.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clawmaster-probe-')));
  roots.push(root);
  const protectedDir = join(root, 'protected');
  await mkdir(join(protectedDir, 'inner'), { recursive: true });
  await writeFile(join(root, 'note.md'), 'hello');
  await symlink(protectedDir, join(root, 'link'));
  return { root, protectedDir, file: join(root, 'note.md'), link: join(root, 'link') };
}

const call = command => ({ name: 'bash', arguments: { command } });
const context = (probe, cwd = '/tmp') => ({ home: '/Users/x', cwd, ...probe === undefined ? {} : { probe } });
const probeOf = targets => targets.map(target => ({
  target, exists: true, kind: 'directory', symlink: false,
}));

describe('target inspection', () => {
  it('reports what is really there, including what a link resolves to', async () => {
    const { root, protectedDir, file, link } = await tree();
    const [note, directory, linked, missing] = probeTargets([file, protectedDir, link, join(root, 'gone')]);
    assert.deepEqual([note.kind, note.exists, note.size, note.symlink], ['file', true, 5, false]);
    assert.equal(directory.kind, 'directory');
    assert.equal(linked.symlink, true);
    assert.equal(linked.kind, 'directory', 'a link reports what it points at');
    assert.equal(linked.realPath, protectedDir);
    assert.deepEqual([missing.exists, missing.kind], [false, 'missing']);
  });

  it('never inspects more targets than its bound and ignores the "no target" marker', async () => {
    const { root } = await tree();
    const targets = ['-', ...Array.from({ length: MAX_PROBE_TARGETS + 4 }, (_, index) => join(root, `t${index}`))];
    assert.equal(probeTargets(targets).length, MAX_PROBE_TARGETS);
    assert.deepEqual(probeTargets(['-']), []);
  });

  it('describes a probe in one clause, and says plainly when nothing is there', async () => {
    const { protectedDir, file, link } = await tree();
    const [note, directory, linked, missing] = probeTargets([file, protectedDir, link, join(protectedDir, 'gone')]);
    assert.equal(describeProbe(note), 'file, 5 bytes, exists');
    assert.equal(describeProbe(directory), 'directory, exists');
    assert.equal(describeProbe(linked), `directory, exists, a link to ${protectedDir}`);
    assert.equal(describeProbe(missing), 'missing — nothing exists there to destroy');
  });

  it('matches a protected prefix through the link as well as through the literal path', async () => {
    const { protectedDir, link, root } = await tree();
    const [linked, literal, elsewhere] = probeTargets([link, join(protectedDir, 'inner'), root]);
    assert.equal(resolvedUnder(linked, [protectedDir]), protectedDir);
    assert.equal(resolvedUnder(literal, [protectedDir]), protectedDir);
    assert.equal(resolvedUnder(elsewhere, [protectedDir]), undefined);
    assert.equal(resolvedUnder(elsewhere, ['']), undefined, 'an empty prefix protects nothing');
  });
});

describe('decisions', () => {
  it('denies a symlink whose contents sit under a protected path', () => {
    const link = '/tmp/scratch/link';
    const review = reviewCall(call(`rm -rf ${link}`), { ...DEFAULT_OPTIONS, denyPaths: ['/srv/data'] },
      context(targets => targets.map(target => ({ target, exists: true, kind: 'directory', symlink: true, realPath: '/srv/data/notes' }))));
    assert.equal(review.decision.kind, 'deny');
    assert.match(review.decision.reason, /is a link to \/srv\/data\/notes, under \/srv\/data/);
  });

  it('denies a target that merely resolves into a protected path', () => {
    const review = reviewCall(call('rm -rf /var/scratch'), { ...DEFAULT_OPTIONS, denyPaths: ['/private/var/scratch'] },
      context(targets => targets.map(target => ({ target, exists: true, kind: 'directory', symlink: false, realPath: '/private/var/scratch' }))));
    assert.equal(review.decision.kind, 'deny');
    assert.match(review.decision.reason, /resolves to \/private\/var\/scratch, under \/private\/var\/scratch/);
  });

  it('states what the target is, and never softens a verdict because it is missing', () => {
    const review = reviewCall(call('rm -rf /tmp/scratch'), DEFAULT_OPTIONS,
      context(targets => targets.map(target => ({ target, exists: false, kind: 'missing', symlink: false }))));
    assert.equal(review.decision.kind, 'ask', 'a missing target still needs the user, because parsing is not proof');
    assert.match(review.decision.reason, /Targets: \/tmp\/scratch \(missing — nothing exists there to destroy\)/);
    assert.deepEqual(review.probes.map(probe => probe.kind), ['missing']);
  });

  it('names every target it inspected, and inspects the real ones by default', async () => {
    const { root, file } = await tree();
    const review = reviewCall(call('rm note.md absent'), DEFAULT_OPTIONS, { home: root, cwd: root });
    assert.equal(review.decision.kind, 'ask');
    assert.ok(review.decision.reason.includes(`${file.replaceAll('\\', '/')} (file, 5 bytes, exists)`));
    assert.match(review.decision.reason, /\/absent \(missing/);
  });

  it('leaves the verdict alone when the inspection throws or the command names nothing', () => {
    const thrown = reviewCall(call('rm -rf /tmp/scratch'), DEFAULT_OPTIONS,
      context(() => { throw new Error('stat failed'); }));
    assert.equal(thrown.decision.kind, 'ask');
    assert.deepEqual(thrown.probes, []);
    const noTarget = reviewCall(call('git status'), DEFAULT_OPTIONS, context(probeOf));
    assert.equal(noTarget.decision, undefined);
    assert.deepEqual(noTarget.probes, []);
  });

  it('inspects during observe mode without deciding', () => {
    const review = reviewCall(call('rm -rf /tmp/scratch'), { ...DEFAULT_OPTIONS, mode: 'observe' }, context(probeOf));
    assert.equal(review.decision, undefined);
    assert.equal(review.probes.length, 1);
  });
});
