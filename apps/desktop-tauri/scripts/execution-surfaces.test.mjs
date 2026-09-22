import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { INVENTORY_SCHEMA_VERSION, checkExecutionSurfaces, inventoryPath, readInventory } from './execution-surfaces.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** One well-formed enforced surface, so a negative case can perturb exactly one field. */
function surface(overrides = {}) {
  return {
    id: 'sample',
    surface: 'A sample surface.',
    enforcer: 'packages/fs/fs-sandbox/src/index.ts',
    authorization: 'packages/sandbox/sandbox/src/roots.ts',
    mechanism: 'path-allow-list',
    evidence: ['packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts'],
    status: 'enforced',
    ...overrides,
  }
}

/** @param {object[]} surfaces @returns {object} Inventory document. */
function inventory(surfaces) {
  return { schemaVersion: INVENTORY_SCHEMA_VERSION, surfaces }
}

/** @param {object} document @returns {string[]} Finding ids raised for a document. */
function ids(document) {
  return checkExecutionSurfaces(document, repositoryRoot).findings.map(finding => finding.id)
}

test('the shipped inventory resolves every surface to its gate and authority', () => {
  const document = readInventory(inventoryPath(repositoryRoot))
  const result = checkExecutionSurfaces(document, repositoryRoot)
  assert.deepEqual(result.findings, [])
  assert.equal(result.ok, true)
  assert.ok(result.counts.enforced >= 1, 'at least one surface names the gate that refuses it')
  assert.ok(result.counts.unenforced + result.counts.unclassified >= 1, 'the inventory also records what it has not established rather than hiding it')
  assert.equal(result.counts.enforced + result.counts.unenforced + result.counts.unclassified, document.surfaces.length, 'every surface is counted exactly once')
})

test('an unexamined surface must say so instead of reading as safe', () => {
  const unexamined = { id: 'sample', surface: 'A sample surface.', status: 'unclassified', reason: 'The gate has not been established.' }
  assert.deepEqual(checkExecutionSurfaces(inventory([unexamined]), repositoryRoot).findings, [])
  assert.ok(ids(inventory([{ ...unexamined, reason: undefined }])).includes('surface-unclassified-without-reason'))
  assert.ok(ids(inventory([{ ...unexamined, mechanism: 'role-check' }])).includes('surface-unclassified-without-enforcement'))
})

test('an enforced surface must name both the gate and the authority behind it', () => {
  assert.deepEqual(checkExecutionSurfaces(inventory([surface()]), repositoryRoot).findings, [])
  assert.ok(ids(inventory([surface({ enforcer: undefined })])).includes('surface-missing-enforcer'))
  assert.ok(ids(inventory([surface({ authorization: undefined })])).includes('surface-missing-authorization'))
  assert.ok(ids(inventory([surface({ enforcer: '' })])).includes('surface-missing-enforcer'))
})

test('a gate no test exercises cannot be claimed as enforced', () => {
  assert.ok(ids(inventory([surface({ evidence: [] })])).includes('surface-enforced-without-evidence'))
  assert.ok(ids(inventory([surface({ evidence: undefined })])).includes('surface-enforced-without-evidence'))
})

test('an unenforced surface states the gap and cannot name a gate', () => {
  const gap = { id: 'sample', surface: 'A sample surface.', status: 'unenforced', reason: 'No egress policy exists.' }
  assert.deepEqual(checkExecutionSurfaces(inventory([gap]), repositoryRoot).findings, [])
  assert.ok(ids(inventory([{ ...gap, reason: undefined }])).includes('surface-unenforced-without-reason'))
  assert.ok(ids(inventory([{ ...gap, reason: '' }])).includes('surface-unenforced-without-reason'))
  assert.ok(ids(inventory([{ ...gap, enforcer: 'packages/fs/fs-sandbox/src/index.ts' }])).includes('surface-unenforced-with-enforcer'))
})

test('a surface names an existing gate and authority in the checkout', () => {
  assert.ok(ids(inventory([surface({ enforcer: 'packages/fs/fs-sandbox/src/does-not-exist.ts' })])).includes('surface-enforcer-missing'))
  assert.ok(ids(inventory([surface({ authorization: 'packages/sandbox/sandbox/src/does-not-exist.ts' })])).includes('surface-authorization-missing'))
  assert.ok(ids(inventory([surface({ evidence: ['packages/fs/fs-sandbox/tests/does-not-exist.spec.ts'] })])).includes('surface-evidence-missing'))
  assert.ok(ids(inventory([surface({ authorization: '/etc/passwd' })])).includes('surface-path-absolute'))
})

test('an authority outside the checkout must be named as external rather than faked as a path', () => {
  const document = inventory([surface({ authorization: { external: 'the host-supplied workspace upload implementation' } })])
  assert.deepEqual(checkExecutionSurfaces(document, repositoryRoot).findings, [])
  assert.ok(ids(inventory([surface({ authorization: { external: '' } })])).includes('surface-missing-authorization'))
  assert.ok(ids(inventory([surface({ authorization: { path: 'packages/fs/fs-sandbox/src/index.ts' } })])).includes('surface-missing-authorization'))
})

test('an unknown status or mechanism is refused rather than guessed at', () => {
  assert.ok(ids(inventory([surface({ status: 'probably' })])).includes('surface-unknown-status'))
  assert.ok(ids(inventory([surface({ mechanism: 'vibes' })])).includes('surface-unknown-mechanism'))
  assert.ok(ids(inventory([surface({ mechanism: undefined })])).includes('surface-unknown-mechanism'))
})

test('a surface with no id, a repeated id, or an empty inventory is refused', () => {
  assert.ok(ids(inventory([surface({ id: undefined })])).includes('surface-schema'))
  assert.ok(ids(inventory([surface(), surface()])).includes('surface-duplicate-id'))
  assert.ok(ids(inventory([])).includes('inventory-schema'))
})

test('an inventory with the wrong revision or no surfaces array is refused', () => {
  assert.ok(ids({ schemaVersion: 99, surfaces: [surface()] }).includes('inventory-schema'))
  assert.ok(ids({ schemaVersion: INVENTORY_SCHEMA_VERSION }).includes('inventory-schema'))
})
