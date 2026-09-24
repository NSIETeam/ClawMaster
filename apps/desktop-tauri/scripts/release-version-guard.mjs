/**
 * Refuse a desktop release whose version trails a published version in its own line.
 *
 * `version.json` is one editable file, and the release tags are the only record of
 * what shipped. On 2026-09-18 commit `1faa6a869c` moved the version sources from
 * `0.2.8` back to `0.2.3` while `desktop-v0.2.7` was already published; nothing in
 * the workflow compared the two, so the next release would have been built as an
 * older program than the one users were already running.
 *
 * The comparison is scoped to the candidate's `major.minor` line, because moving to
 * another line is a deliberate product decision, while a version that trails a
 * published version of its own line is the accident above.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDesktopVersion } from './desktop-version.mjs'

const TAG_PREFIX = 'desktop-v'
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const STABLE_DISPLAY = /^((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))-release$/
const PRERELEASE = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/

/**
 * The program version a desktop tag publishes. Stable releases accept the
 * `-release` display suffix, which names the same program version.
 * @param {string} tag
 * @returns {string | null} The program version, or null for a non-desktop tag.
 */
export function programVersionOf(tag) {
  if (!tag.startsWith(TAG_PREFIX)) return null
  const suffix = tag.slice(TAG_PREFIX.length)
  if (STABLE.test(suffix)) return suffix
  const display = STABLE_DISPLAY.exec(suffix)
  if (display) return display[1]
  if (PRERELEASE.test(suffix)) return suffix
  return null
}

/** @param {string} version @returns {{ numbers: number[], prerelease: string[] }} */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`Unsupported desktop version: ${version}`)
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split('.') : [] }
}

/**
 * Order two program versions by release precedence: numeric fields first, then a
 * prerelease below the release it precedes.
 * @param {string} left
 * @param {string} right
 * @returns {number} Negative when `left` precedes `right`, positive when it follows it.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) < Number(y) ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * @param {{ version: string, tags: string[], releasing?: string }} input `tags` is the
 *   full `desktop-v*` tag list and `releasing` the tag under construction, which is
 *   excluded because a candidate branch is tagged before its own build runs.
 * @returns {string} The accepted version.
 */
export function guardReleaseVersion({ version, tags, releasing }) {
  const numbers = parseVersion(version).numbers
  const line = `${numbers[0]}.${numbers[1]}`
  const shipped = []
  for (const tag of tags) {
    if (tag === releasing) continue
    const program = programVersionOf(tag)
    if (program === null) throw new Error(`Desktop tag ${tag} does not name a program version`)
    const published = parseVersion(program).numbers
    if (`${published[0]}.${published[1]}` === line) shipped.push(program)
  }
  const newest = shipped.sort(compareVersions).at(-1)
  if (newest !== undefined && compareVersions(newest, version) > 0) {
    throw new Error(`Desktop version ${version} is behind the published ${newest} in the ${line} line; move version.json forward before building`)
  }
  return version
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  if (process.argv[2] !== '--check') throw new Error('Use --check <release-tag>')
  const version = await readDesktopVersion(root)
  const tags = execFileSync('git', ['tag', '--list', `${TAG_PREFIX}*`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  guardReleaseVersion({ version, tags, releasing: process.argv[3] })
  console.log(`Desktop version ${version} is ahead of every published desktop tag`)
}
