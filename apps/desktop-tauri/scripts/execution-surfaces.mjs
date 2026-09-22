/** Check the execution-surface inventory: every way this product can change the machine names its enforcer and its authorization source, or states why it has neither. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** Inventory revision understood by this checker. */
export const INVENTORY_SCHEMA_VERSION = 1

/**
 * Status of an execution surface: `enforced` names its gate, `unenforced` states that
 * nothing gates it, `unclassified` states that this inventory has not established the
 * gate. The third exists so an unexamined surface stays visible instead of reading as safe.
 */
export const SURFACE_STATUSES = ['enforced', 'unenforced', 'unclassified']

/** Mechanism by which a surface is gated. A value outside this set is a typo or an unclassified gate. */
export const ENFORCEMENT_MECHANISMS = [
  'user-approval',
  'path-allow-list',
  'revision-precondition',
  'signature-verification',
  'role-check',
  'mode-restriction',
  'closed-vocabulary',
]

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Read the inventory document.
 * @param {string} path Inventory JSON path.
 * @returns {object} Parsed inventory.
 */
export function readInventory(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Resolve one repository-relative path a surface names.
 * @param {string} root Repository root.
 * @param {string} field Field the path came from.
 * @param {string} path Repository-relative path.
 * @param {(id:string, entry:string|null, problem:string, evidence:string)=>void} fail Finding sink.
 * @param {string} label Entry label.
 * @returns {boolean} Whether the path resolves to a non-empty file in the checkout.
 */
function checkPath(root, field, path, fail, label) {
  if (isAbsolute(path)) {
    fail('surface-path-absolute', label, `${field} must be repository-relative.`, path)
    return false
  }
  const target = join(root, path)
  if (!existsSync(target)) {
    fail(`surface-${field}-missing`, label, `A ${field} path the inventory names does not exist.`, path)
    return false
  }
  if (statSync(target).isDirectory()) return true
  if (statSync(target).size === 0) {
    fail(`surface-${field}-empty`, label, `A ${field} path the inventory names is empty.`, path)
    return false
  }
  return true
}

/**
 * Resolve one authority a surface names. An authority is either a module in this
 * checkout or an explicitly external supplier, because some surfaces are gated
 * by a component the checkout does not contain.
 * @param {string} root Repository root.
 * @param {unknown} authority Authority as written in the entry.
 * @param {(id:string, entry:string|null, problem:string, evidence:string)=>void} fail Finding sink.
 * @param {string} label Entry label.
 */
function checkAuthority(root, authority, fail, label) {
  if (isNonEmptyString(authority)) {
    checkPath(root, 'authorization', authority, fail, label)
    return
  }
  if (isRecord(authority) && isNonEmptyString(authority.external)) return
  fail('surface-missing-authorization', label,
    'An enforced surface must name where the permission being exercised comes from, as a repository path or as an explicit external supplier.',
    `authorization = ${JSON.stringify(authority ?? null)}`)
}

/**
 * Check one inventory against the checkout it describes.
 * A surface that is gated must name both the gate and the authority behind it; a
 * surface that is not gated must say so. Neither may stay silent.
 * @param {object} inventory Parsed inventory document.
 * @param {string} root Repository root the surfaces' paths resolve against.
 * @returns {{ok:boolean, findings:{id:string, surface:string|null, problem:string, evidence:string}[], counts:{enforced:number, unenforced:number, unclassified:number}}}
 */
export function checkExecutionSurfaces(inventory, root) {
  const findings = []
  const checkout = resolve(root)
  const fail = (id, entry, problem, evidence) => findings.push({ id, surface: entry, problem, evidence })

  if (!isRecord(inventory) || typeof inventory.schemaVersion !== 'number') {
    fail('inventory-schema', null, 'The inventory must carry a numeric schemaVersion.', `schemaVersion = ${JSON.stringify(inventory?.schemaVersion ?? null)}`)
  } else if (inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    fail('inventory-schema', null, `The inventory must use schema version ${INVENTORY_SCHEMA_VERSION}.`, `schemaVersion = ${JSON.stringify(inventory.schemaVersion)}`)
  }
  const surfaces = Array.isArray(inventory?.surfaces) ? inventory.surfaces : null
  if (!surfaces) {
    fail('inventory-schema', null, 'The inventory must carry a surfaces array.', `surfaces = ${JSON.stringify(inventory?.surfaces ?? null)}`)
    return { ok: false, findings, counts: { enforced: 0, unenforced: 0, unclassified: 0 } }
  }
  if (surfaces.length === 0) {
    fail('inventory-schema', null, 'An inventory with no surfaces cannot describe what the product can change.', 'surfaces = []')
  }

  const seen = new Set()
  let enforced = 0
  let unenforced = 0
  let unclassified = 0
  for (const [index, entry] of surfaces.entries()) {
    const label = isRecord(entry) && typeof entry.id === 'string' ? entry.id : `surfaces[${String(index)}]`
    if (!isRecord(entry)) {
      fail('surface-schema', label, 'Each surface must be an object.', `surfaces[${String(index)}] = ${JSON.stringify(entry)}`)
      continue
    }
    if (!isNonEmptyString(entry.id)) {
      fail('surface-schema', label, 'Each surface needs a non-empty id.', `id = ${JSON.stringify(entry.id ?? null)}`)
      continue
    }
    if (seen.has(entry.id)) {
      fail('surface-duplicate-id', label, 'Two surfaces share one id, so the inventory cannot be read unambiguously.', `duplicate id ${entry.id}`)
    }
    seen.add(entry.id)
    if (!isNonEmptyString(entry.surface)) {
      fail('surface-schema', label, 'Each surface must state what it can change.', `surface = ${JSON.stringify(entry.surface ?? null)}`)
    }
    if (!SURFACE_STATUSES.includes(entry.status)) {
      fail('surface-unknown-status', label, `Status must be one of ${SURFACE_STATUSES.join(', ')}.`, `status = ${JSON.stringify(entry.status ?? null)}`)
      continue
    }
    const status = entry.status
    if (status === 'enforced') enforced += 1
    else if (status === 'unenforced') unenforced += 1
    else unclassified += 1

    if (entry.evidence !== undefined && !isStringArray(entry.evidence)) {
      fail('surface-schema', label, 'evidence must be a list of non-empty paths.', `evidence = ${JSON.stringify(entry.evidence)}`)
    }
    const evidence = isStringArray(entry.evidence) ? entry.evidence : []
    for (const path of evidence) checkPath(checkout, 'evidence', path, fail, label)

    if (status !== 'enforced') {
      if (!isNonEmptyString(entry.reason)) {
        fail(status === 'unenforced' ? 'surface-unenforced-without-reason' : 'surface-unclassified-without-reason', label,
          status === 'unenforced' ? 'An unenforced surface must state what is missing, not stay silent.' : 'An unclassified surface must state what this inventory has not established.', `reason = ${JSON.stringify(entry.reason ?? null)}`)
      }
      if (entry.mechanism !== undefined) {
        fail(`surface-${status}-without-enforcement`, label, `A surface that is not enforced cannot also name a mechanism.`, `mechanism = ${JSON.stringify(entry.mechanism)}`)
      }
      if (status === 'unenforced' && entry.enforcer !== undefined && entry.enforcer !== null) {
        fail('surface-unenforced-with-enforcer', label, 'An unenforced surface cannot also name the gate that stops it.', `enforcer = ${JSON.stringify(entry.enforcer)}`)
      }
      continue
    }

    if (!isNonEmptyString(entry.enforcer)) {
      fail('surface-missing-enforcer', label, 'An enforced surface must name the module that refuses it.', `enforcer = ${JSON.stringify(entry.enforcer ?? null)}`)
    } else {
      checkPath(checkout, 'enforcer', entry.enforcer, fail, label)
    }
    checkAuthority(checkout, entry.authorization, fail, label)
    if (!ENFORCEMENT_MECHANISMS.includes(entry.mechanism)) {
      fail('surface-unknown-mechanism', label, `mechanism must be one of ${ENFORCEMENT_MECHANISMS.join(', ')}.`, `mechanism = ${JSON.stringify(entry.mechanism ?? null)}`)
    }
    if (evidence.length === 0) {
      fail('surface-enforced-without-evidence', label, 'A gate that no test exercises cannot be claimed as enforced.', `evidence = ${JSON.stringify(entry.evidence ?? null)}`)
    }
  }

  return { ok: findings.length === 0, findings, counts: { enforced, unenforced, unclassified } }
}

/**
 * Resolve the inventory path inside a checkout.
 * @param {string} root Repository root.
 * @returns {string} Inventory JSON path.
 */
export function inventoryPath(root) {
  return join(root, 'apps', 'desktop-tauri', 'execution-surfaces.json')
}

/**
 * Resolve the checkout this module ships in, independent of the working directory.
 * @returns {string} Repository root.
 */
export function repositoryRoot() {
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootIndex = process.argv.indexOf('--root')
  const root = rootIndex === -1 ? repositoryRoot() : resolve(process.argv[rootIndex + 1])
  const result = checkExecutionSurfaces(readInventory(inventoryPath(root)), root)
  for (const finding of result.findings) process.stderr.write(`${finding.id} [${finding.surface ?? '-'}] ${finding.problem} (${finding.evidence})\n`)
  process.stdout.write(`execution surfaces: enforced=${result.counts.enforced} unenforced=${result.counts.unenforced} unclassified=${result.counts.unclassified} findings=${result.findings.length}\n`)
  process.exit(result.ok ? 0 : 1)
}
