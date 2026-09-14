/** Risk classification: what the guard must catch, and what it must leave alone. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectShellCommand } from '../src/classify.ts';

const context = { home: '/Users/king', cwd: '/Users/king/Documents/ChatGPT/ClawMaster' };

/** Table of [command, expected risk, expected rule code]. */
const cases = [
  // Irreversible: roots, home, wildcards and version history.
  ['rm -rf /', 'critical', 'delete.broad'],
  ['sudo rm -rf /', 'critical', 'delete.broad'],
  ['rm -rf ~', 'critical', 'delete.broad'],
  ['rm -rf $HOME', 'critical', 'delete.broad'],
  ['rm -rf .', 'critical', 'delete.broad'],
  ['rm -rf ..', 'critical', 'delete.broad'],
  ['rm -rf *', 'critical', 'delete.broad'],
  ['rm --no-preserve-root -rf /', 'critical', 'delete.no-preserve-root'],
  ['rm -rf .git', 'critical', 'vcs.remove-history'],
  ['HOME=/tmp rm -rf ~/important', 'critical', 'delete.shadowed-home'],
  ['find / -name "*.log" -delete', 'critical', 'find.delete-broad'],
  ['mkfs.ext4 /dev/disk2', 'critical', 'disk.destroy'],
  ['dd if=/dev/zero of=/dev/disk2 bs=1m', 'critical', 'disk.destroy'],
  ['chmod -R 777 /', 'critical', 'perm.recursive-root'],
  [':(){ :|:& };:', 'critical', 'resource.fork-bomb'],

  // Destructive but bounded: named paths, history rewrites, releases, services.
  ['rm -rf ./node_modules', 'high', 'delete.path'],
  ['rm -rf build dist/report.html', 'high', 'delete.path'],
  ['rm notes.md', 'high', 'delete.path'],
  ['find ./build -delete', 'high', 'find.delete'],
  ['chmod -R 777 ./dist', 'high', 'perm.recursive'],
  ['git reset --hard HEAD~1', 'high', 'git.reset-hard'],
  ['git clean -fdx', 'high', 'git.clean'],
  ['git checkout -- .', 'high', 'git.checkout-broad'],
  ['git branch -D feature', 'high', 'git.branch-delete'],
  ['git stash clear', 'high', 'git.stash-drop'],
  ['git push --force origin main', 'high', 'git.force-push'],
  ['git filter-branch --tree-filter "true" HEAD', 'high', 'git.history-rewrite'],
  ['npm publish --access public', 'high', 'release.publish'],
  ['docker system prune -af', 'high', 'docker.destroy'],
  ['kubectl delete pod api-1', 'high', 'cluster.delete'],
  ['terraform destroy -auto-approve', 'high', 'infra.destroy'],
  ['rsync -a --delete ./site/ /backup/site/', 'high', 'sync.delete'],
  ['psql -c "DROP TABLE users"', 'high', 'db.drop'],
  ['sqlite3 app.db "DELETE FROM users"', 'high', 'db.delete-all'],
  ['kill -9 4242', 'high', 'process.kill'],
  ['truncate -s 0 notes.md', 'high', 'file.truncate'],

  // Writes and reads a normal working session depends on.
  ['echo hi > out.txt', 'medium', 'write.redirect'],
  ['sqlite3 app.db "DELETE FROM users WHERE id = 1"', 'low', 'safe'],
  ['ls -la', 'low', 'safe'],
  ['git status --short', 'low', 'safe'],
  ['git commit -m "guard: add the review layer"', 'low', 'safe'],
  ['pnpm run test:notes-client', 'low', 'safe'],
  ['node --test tests/*.test.mjs', 'low', 'safe'],
  ['mkdir -p frontends/guard/src', 'low', 'safe'],
  ['rg "rm -rf" docs/', 'low', 'safe'],
  ['rm', 'low', 'safe'],
];

describe('shell classification', () => {
  for (const [command, risk, code] of cases) {
    it(`${risk}/${code}: ${command}`, () => {
      const finding = inspectShellCommand(command, context);
      assert.equal(finding.risk, risk, `${command} → ${finding.code}: ${finding.reason}`);
      assert.equal(finding.code, code);
      assert.ok(finding.reason.length > 0);
    });
  }

  it('reports the resolved target rather than the word as written', () => {
    const finding = inspectShellCommand('rm -rf ./node_modules', context);
    assert.deepEqual(finding.targets, ['/Users/king/Documents/ChatGPT/ClawMaster/node_modules']);
  });

  it('expands a home-relative target', () => {
    const finding = inspectShellCommand('rm -rf ~/tmp/scratch', context);
    assert.deepEqual(finding.targets, ['/Users/king/tmp/scratch']);
  });

  it('finds a destructive command behind a chain and inside a subshell', () => {
    assert.equal(inspectShellCommand('cd /tmp && rm -rf /', context).risk, 'critical');
    assert.equal(inspectShellCommand('(rm -rf ~)', context).risk, 'critical');
    assert.equal(inspectShellCommand('cd /tmp; git reset --hard', context).risk, 'high');
  });

  it('does not fire on quoted text that merely mentions a command', () => {
    const finding = inspectShellCommand(`git commit -m "docs: explain rm -rf and DROP TABLE"`, context);
    assert.equal(finding.risk, 'low', `${finding.code}: ${finding.reason}`);
  });
});
