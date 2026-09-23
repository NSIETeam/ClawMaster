/** Inventory and archive uncommitted work without altering the working tree or deleting unknown files. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Inventory document revision understood by consumers of the emitted JSON. */
export const INVENTORY_SCHEMA_VERSION = 1
/** Files larger than this keep their size and mtime but are not digested. */
export const MAX_DIGEST_BYTES = 64 * 1024 * 1024

/** @param {string} root @param {string[]} args @returns {Buffer} Git output with no inherited stdio. */
function gitBuffer(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

/** @param {string} root @param {string[]} args @returns {string} Trimmed Git output. */
function gitText(root, args) {
  return gitBuffer(root, args).toString('utf8').trim()
}

/**
 * Read Git output that carries significant leading whitespace.
 * `--porcelain` marks an unstaged-only change as ` M`, so trimming the buffer
 * would shift every path by one character.
 * @param {string} root @param {string[]} args @returns {string} Untrimmed Git output.
 */
function gitRawText(root, args) {
  return gitBuffer(root, args).toString('utf8')
}

/**
 * Split `git status --porcelain=v1 -z` output into one record per entry.
 * A rename or copy entry carries the new path first and the original second.
 * @param {string} raw
 * @returns {{status:string, path:string, originalPath:string|null}[]}
 */
function parsePorcelainStatus(raw) {
  const fields = raw.split('\0')
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    const path = field.slice(3)
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      const originalPath = fields[index + 1] ?? null
      index += 1
      entries.push({ status, path, originalPath })
      continue
    }
    entries.push({ status, path, originalPath: null })
  }
  return entries
}

/**
 * Describe one working-tree path without following symlinks.
 * @param {string} root @param {string} path @returns {{path:string, kind:string, size:number|null, mtimeMs:number|null, sha256:string|null, linkTarget:string|null}}
 */
function describePath(root, path) {
  const absolute = join(root, path)
  const stats = lstatSync(absolute)
  if (stats.isSymbolicLink()) {
    return { path, kind: 'symlink', size: null, mtimeMs: null, sha256: null, linkTarget: readlinkSync(absolute) }
  }
  if (stats.isDirectory()) {
    return { path, kind: 'directory', size: null, mtimeMs: null, sha256: null, linkTarget: null }
  }
  const digestable = stats.isFile() && stats.size <= MAX_DIGEST_BYTES
  return {
    path,
    kind: 'file',
    size: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
    sha256: digestable ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null,
    linkTarget: null,
  }
}

/**
 * Capture every tracked change and untracked entry in a checkout.
 * The result is evidence: it never writes, stages, or removes anything.
 * @param {string} root Checkout to inspect; defaults to the current directory.
 * @returns {object} Inventory document.
 */
export function captureWorktreeInventory(root = process.cwd()) {
  const checkout = resolve(root)
  const status = gitRawText(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = parsePorcelainStatus(status)
  const tracked = []
  const untracked = []
  for (const entry of entries) {
    const described = describePath(checkout, entry.path)
    const record = { ...described, status: entry.status, originalPath: entry.originalPath }
    if (entry.status === '??') untracked.push(record)
    else if (entry.status !== '!!') tracked.push(record)
  }
  tracked.sort((left, right) => left.path.localeCompare(right.path))
  untracked.sort((left, right) => left.path.localeCompare(right.path))
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    checkout,
    head: gitText(checkout, ['rev-parse', 'HEAD']),
    branch: gitText(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: tracked.length + untracked.length > 0,
    counts: { tracked: tracked.length, untracked: untracked.length },
    tracked,
    untracked,
  }
}

/** @param {object} inventory @returns {string} Human-readable inventory with one row per path. */
export function renderInventoryMarkdown(inventory) {
  const lines = [
    '# Uncommitted work inventory',
    '',
    `- Checkout: \`${inventory.checkout}\``,
    `- HEAD: \`${inventory.head}\` (branch \`${inventory.branch}\`)`,
    `- Captured: ${inventory.capturedAt}`,
    `- Tracked changes: ${inventory.counts.tracked}; untracked entries: ${inventory.counts.untracked}`,
    '',
    '## Tracked changes',
    '',
    '| Status | Path | Kind | Bytes | SHA-256 |',
    '| --- | --- | --- | --- | --- |',
  ]
  const row = entry => `| \`${entry.status}\` | \`${entry.path}\` | ${entry.kind} | ${entry.size ?? ''} | ${entry.sha256 ?? ''} |`
  lines.push(...(inventory.tracked.length ? inventory.tracked.map(row) : ['| — | — | — | — | — |']))
  lines.push('', '## Untracked entries', '', '| Path | Kind | Bytes | SHA-256 |', '| --- | --- | --- | --- |')
  const untrackedRow = entry => `| \`${entry.path}\` | ${entry.kind} | ${entry.size ?? ''} | ${entry.sha256 ?? ''} |`
  lines.push(...(inventory.untracked.length ? inventory.untracked.map(untrackedRow) : ['| — | — | — | — |']))
  lines.push('', 'Nothing on this list is staged, rewritten, or deleted by this tool.', '')
  return lines.join('\n')
}

/**
 * Write the inventory as JSON and Markdown under one directory.
 * @param {object} inventory @param {string} outDir @returns {{jsonPath:string, markdownPath:string}}
 */
export function writeInventory(inventory, outDir) {
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, 'worktree-inventory.json')
  const markdownPath = join(outDir, 'worktree-inventory.md')
  writeFileSync(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`)
  writeFileSync(markdownPath, renderInventoryMarkdown(inventory))
  return { jsonPath, markdownPath }
}

/**
 * Archive the uncommitted work next to the inventory: a binary patch for tracked
 * changes and a tar of the tracked plus untracked paths. Sources stay untouched.
 * @param {string} root @param {object} inventory @param {string} outDir
 * @returns {{patchPath:string, archivePath:string, archivedPaths:string[]}}
 */
export function archiveUncommittedWork(root, inventory, outDir) {
  const checkout = resolve(root)
  mkdirSync(outDir, { recursive: true })
  const patchPath = join(outDir, 'worktree-changes.patch')
  writeFileSync(patchPath, gitBuffer(checkout, ['diff', '--binary', 'HEAD']))
  const archivedPaths = [...inventory.tracked.filter(entry => entry.kind === 'file').map(entry => entry.path), ...inventory.untracked.filter(entry => entry.kind === 'file').map(entry => entry.path)]
  const archivePath = join(outDir, 'worktree-files.tar.gz')
  const listPath = join(outDir, 'worktree-files.list')
  writeFileSync(listPath, archivedPaths.length ? `${archivedPaths.join('\n')}\n` : '')
  execFileSync('tar', ['-czf', archivePath, '-T', listPath], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] })
  return { patchPath, archivePath, archivedPaths }
}

/**
 * Run the inventory for a checkout and report where the evidence landed.
 * @param {{root?:string, outDir:string}} options
 * @returns {{inventory:object, jsonPath:string, markdownPath:string, patchPath:string, archivePath:string}}
 */
export function runWorktreeInventory({ root = process.cwd(), outDir }) {
  const inventory = captureWorktreeInventory(root)
  const { jsonPath, markdownPath } = writeInventory(inventory, outDir)
  const { patchPath, archivePath } = archiveUncommittedWork(inventory.checkout, inventory, outDir)
  return { inventory, jsonPath, markdownPath, patchPath, archivePath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const outIndex = process.argv.indexOf('--out')
  const outDir = outIndex === -1 ? join(process.cwd(), '.dsh-build', 'worktree-inventory') : resolve(process.argv[outIndex + 1])
  const result = runWorktreeInventory({ outDir })
  process.stdout.write(`tracked=${result.inventory.counts.tracked} untracked=${result.inventory.counts.untracked}\n${result.markdownPath}\n${result.archivePath}\n`)
}
