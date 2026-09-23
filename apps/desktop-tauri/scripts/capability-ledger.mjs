/** Check the capability ledger: every product promise resolves to its source, code, evidence and platforms. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** Ledger revision understood by this checker. */
export const LEDGER_SCHEMA_VERSION = 1

/** Platforms a capability entry may claim. A claim outside this set is a typo or an unmeasured platform. */
export const KNOWN_PLATFORMS = ['macos-arm64', 'windows-x64', 'linux-x64', 'android']

/** Status of a claimed capability: `verified` needs evidence, `unevidenced` needs a stated reason. */
export const CAPABILITY_STATUSES = ['verified', 'unevidenced']

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}

/**
 * Read the ledger document.
 * @param {string} path Ledger JSON path.
 * @returns {object} Parsed ledger.
 */
export function readLedger(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Check one ledger against the checkout it describes.
 * Every finding names the entry and the exact path or field that failed, so a
 * promise cannot be advertised as supported without evidence or a stated gap.
 * @param {object} ledger Parsed ledger document.
 * @param {string} root Repository root the entries' paths resolve against.
 * @returns {{ok:boolean, findings:{id:string, entry:string|null, problem:string, evidence:string}[], counts:{verified:number, unevidenced:number}}}
 */
export function checkCapabilityLedger(ledger, root) {
  const findings = []
  const checkout = resolve(root)
  const fail = (id, entry, problem, evidence) => findings.push({ id, entry, problem, evidence })

  if (!isRecord(ledger) || typeof ledger.schemaVersion !== 'number') {
    fail('ledger-schema', null, 'The ledger must carry a numeric schemaVersion.', `schemaVersion = ${JSON.stringify(ledger?.schemaVersion ?? null)}`)
  } else if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    fail('ledger-schema', null, `The ledger must use schema version ${LEDGER_SCHEMA_VERSION}.`, `schemaVersion = ${JSON.stringify(ledger.schemaVersion)}`)
  }
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : null
  if (!entries) {
    fail('ledger-schema', null, 'The ledger must carry an entries array.', `entries = ${JSON.stringify(ledger?.entries ?? null)}`)
    return { ok: false, findings, counts: { verified: 0, unevidenced: 0 } }
  }

  const seen = new Set()
  let verified = 0
  let unevidenced = 0
  for (const [index, entry] of entries.entries()) {
    const label = isRecord(entry) && typeof entry.id === 'string' ? entry.id : `entries[${String(index)}]`
    if (!isRecord(entry)) {
      fail('entry-schema', label, 'Each entry must be an object.', `entries[${String(index)}] = ${JSON.stringify(entry)}`)
      continue
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      fail('entry-schema', label, 'Each entry needs a non-empty id.', `id = ${JSON.stringify(entry.id ?? null)}`)
      continue
    }
    if (seen.has(entry.id)) {
      fail('entry-duplicate-id', label, 'Two entries share one id, so its promise cannot be read unambiguously.', `duplicate id ${entry.id}`)
    }
    seen.add(entry.id)
    if (typeof entry.promise !== 'string' || entry.promise.length === 0) {
      fail('entry-schema', label, 'Each entry needs the product promise it records.', `promise = ${JSON.stringify(entry.promise ?? null)}`)
    }
    if (entry.status !== undefined && !CAPABILITY_STATUSES.includes(entry.status)) {
      fail('entry-unknown-status', label, `Status must be one of ${CAPABILITY_STATUSES.join(', ')}.`, `status = ${JSON.stringify(entry.status)}`)
    }
    const status = CAPABILITY_STATUSES.includes(entry.status) ? entry.status : 'verified'
    if (status === 'verified') verified += 1
    else unevidenced += 1

    for (const field of ['source', 'code']) {
      if (!isStringArray(entry[field])) {
        fail('entry-schema', label, `${field} must be a list of non-empty paths.`, `${field} = ${JSON.stringify(entry[field] ?? null)}`)
      }
    }
    if (entry.evidence !== undefined && !isStringArray(entry.evidence)) {
      fail('entry-schema', label, 'evidence must be a list of non-empty paths when an entry carries one.', `evidence = ${JSON.stringify(entry.evidence)}`)
    }
    if (Array.isArray(entry.platforms)) {
      for (const platform of entry.platforms) {
        if (!KNOWN_PLATFORMS.includes(platform)) {
          fail('entry-unknown-platform', label, 'A platform outside the known set cannot be claimed as supported.', `platforms includes ${JSON.stringify(platform)}`)
        }
      }
    } else {
      fail('entry-schema', label, 'platforms must list the platforms the promise is asserted for.', `platforms = ${JSON.stringify(entry.platforms ?? null)}`)
    }

    for (const field of ['source', 'code', 'evidence']) {
      if (!isStringArray(entry[field])) continue
      for (const path of entry[field]) {
        if (isAbsolute(path)) {
          fail('entry-path-absolute', label, `${field} must be repository-relative.`, path)
          continue
        }
        const target = join(checkout, path)
        if (!existsSync(target)) {
          fail(`entry-${field}-missing`, label, `A ${field} path the ledger names does not exist.`, path)
          continue
        }
        if (statSync(target).isDirectory()) continue
        if (statSync(target).size === 0) fail(`entry-${field}-empty`, label, `A ${field} path the ledger names is empty.`, path)
      }
    }

    const evidenceList = isStringArray(entry.evidence) ? entry.evidence : []
    if (status === 'verified' && evidenceList.length === 0) {
      fail('entry-verified-without-evidence', label, 'A capability cannot be advertised as verified without an evidence path.', `evidence = ${JSON.stringify(entry.evidence ?? null)}`)
    }
    if (entry.requires !== undefined && !isStringArray(entry.requires)) {
      fail('entry-schema', label, 'requires must be a list of non-empty strings describing what the evidence needs.', `requires = ${JSON.stringify(entry.requires)}`)
    }
    if (status === 'unevidenced' && (typeof entry.reason !== 'string' || entry.reason.length === 0)) {
      fail('entry-unevidenced-without-reason', label, 'An unevidenced capability must state what is missing, not stay silent.', `reason = ${JSON.stringify(entry.reason ?? null)}`)
    }
    if (!isStringArray(entry.code) || entry.code.length === 0) {
      fail('entry-missing-code', label, 'Every promised capability must name the code that ships it.', `code = ${JSON.stringify(entry.code ?? null)}`)
    }
  }

  return { ok: findings.length === 0, findings, counts: { verified, unevidenced } }
}

/**
 * Resolve the ledger path inside a checkout.
 * @param {string} root Repository root.
 * @returns {string} Ledger JSON path.
 */
export function ledgerPath(root) {
  return join(root, 'apps', 'desktop-tauri', 'capability-ledger.json')
}

/**
 * Resolve the checkout this module ships in, independent of the working directory.
 * @returns {string} Repository root.
 */
export function repositoryRoot() {
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const rootIndex = process.argv.indexOf('--root')
  const root = rootIndex === -1 ? repositoryRoot() : resolve(process.argv[rootIndex + 1])
  const result = checkCapabilityLedger(readLedger(ledgerPath(root)), root)
  for (const finding of result.findings) process.stderr.write(`${finding.id} [${finding.entry ?? '-'}] ${finding.problem} (${finding.evidence})\n`)
  process.stdout.write(`capabilities: verified=${result.counts.verified} unevidenced=${result.counts.unevidenced} findings=${result.findings.length}\n`)
  process.exit(result.ok ? 0 : 1)
}
