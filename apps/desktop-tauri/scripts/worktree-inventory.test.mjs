import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { INVENTORY_SCHEMA_VERSION, captureWorktreeInventory, renderInventoryMarkdown, runWorktreeInventory, writeInventory } from './worktree-inventory.mjs'

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A committed checkout carrying one tracked modification and two untracked entries. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'worktree-inventory-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.name', 'Inventory fixture'])
  git(['config', 'user.email', 'inventory@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  write(root, 'app/committed.ts', 'export const before = 1\n')
  write(root, 'notes/kept.md', '# Kept\n')
  git(['add', '.'])
  git(['commit', '-qm', 'fixture source'])
  write(root, 'app/committed.ts', 'export const after = 2\n')
  write(root, 'app/untracked-draft.ts', 'export const draft = true\n')
  write(root, 'notes/handover/pending.md', '# Pending handover\n')
  return { root, git }
}

test('inventory separates tracked changes from untracked entries with content digests', t => {
  const { root } = fixture(t)
  const inventory = captureWorktreeInventory(root)

  assert.equal(inventory.schemaVersion, INVENTORY_SCHEMA_VERSION)
  assert.equal(inventory.dirty, true)
  assert.deepEqual(inventory.counts, { tracked: 1, untracked: 2 })
  assert.deepEqual(inventory.tracked.map(entry => entry.path), ['app/committed.ts'])
  assert.deepEqual(inventory.untracked.map(entry => entry.path), ['app/untracked-draft.ts', 'notes/handover/pending.md'])
  assert.match(inventory.tracked[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(inventory.tracked[0].sha256, inventory.tracked[0].sha256.toLowerCase())
  assert.notEqual(inventory.tracked[0].sha256, null, 'a modified file is digested, not described by size alone')
  assert.equal(inventory.untracked[0].kind, 'file')
  assert.ok(inventory.branch.length > 0, 'the inventory records the branch the work sits on')
})

test('a clean checkout reports no uncommitted work', t => {
  const { root, git } = fixture(t)
  git(['checkout', '--', 'app/committed.ts'])
  rmSync(join(root, 'app/untracked-draft.ts'))
  rmSync(join(root, 'notes/handover'), { recursive: true })
  const inventory = captureWorktreeInventory(root)
  assert.equal(inventory.dirty, false)
  assert.deepEqual(inventory.counts, { tracked: 0, untracked: 0 })
})

test('written inventory states every path in both machined and human form', t => {
  const { root } = fixture(t)
  const outDir = join(root, '..', `${process.pid}-inventory-out`)
  t.after(() => rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const inventory = captureWorktreeInventory(root)
  const { jsonPath, markdownPath } = writeInventory(inventory, outDir)

  assert.equal(JSON.parse(readFileSync(jsonPath, 'utf8')).counts.untracked, 2)
  const markdown = readFileSync(markdownPath, 'utf8')
  for (const path of ['app/committed.ts', 'app/untracked-draft.ts', 'notes/handover/pending.md']) {
    assert.ok(markdown.includes(path), `${path} appears in the human-readable inventory`)
  }
  assert.ok(markdown.includes('Nothing on this list is staged, rewritten, or deleted by this tool.'))
})

test('running the inventory archives the work and leaves every source byte in place', t => {
  const { root } = fixture(t)
  const outDir = join(root, '..', `${process.pid}-inventory-archive`)
  t.after(() => rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const before = readFileSync(join(root, 'app/committed.ts'), 'utf8')

  const result = runWorktreeInventory({ root, outDir })

  assert.ok(existsSync(result.jsonPath) && existsSync(result.markdownPath) && existsSync(result.patchPath) && existsSync(result.archivePath))
  assert.match(readFileSync(result.patchPath, 'utf8'), /diff --git a\/app\/committed\.ts b\/app\/committed\.ts/)
  const listing = execFileSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' })
  assert.ok(listing.includes('app/untracked-draft.ts'))
  assert.ok(listing.includes('notes/handover/pending.md'))
  assert.equal(readFileSync(join(root, 'app/committed.ts'), 'utf8'), before, 'the modified tracked file keeps its working-tree content')
  assert.ok(existsSync(join(root, 'app/untracked-draft.ts')), 'the untracked draft survives the archive step')
})

test('rendered inventory names an empty section instead of omitting it', t => {
  const markdown = renderInventoryMarkdown({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    capturedAt: '2026-09-22T00:00:00.000Z',
    checkout: '/tmp/clean',
    head: '0'.repeat(40),
    branch: 'main',
    dirty: false,
    counts: { tracked: 0, untracked: 0 },
    tracked: [],
    untracked: [],
  })
  assert.ok(markdown.includes('## Tracked changes'))
  assert.ok(markdown.includes('## Untracked entries'))
  assert.equal(markdown.match(/\| — \|/g).length >= 2, true)
})
