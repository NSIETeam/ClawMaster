import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LEDGER_SCHEMA_VERSION, checkCapabilityLedger, ledgerPath, readLedger } from './capability-ledger.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** One well-formed entry, so a negative case can perturb exactly one field. */
function entry(overrides = {}) {
  return {
    id: 'sample',
    promise: 'A sample capability.',
    source: ['frontends/dsh/README.md'],
    code: ['frontends/dsh/src/watchdog-tasks.ts'],
    evidence: ['frontends/dsh/tests/watchdog-tasks.test.mjs'],
    platforms: ['macos-arm64'],
    status: 'verified',
    ...overrides,
  }
}

/** @param {object[]} entries @returns {object} Ledger document. */
function ledger(entries) {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, entries }
}

/** @param {object} document @returns {string[]} Finding ids raised for a document. */
function ids(document) {
  return checkCapabilityLedger(document, repositoryRoot).findings.map(finding => finding.id)
}

test('the shipped ledger resolves every promise to its source, code and evidence', () => {
  const result = checkCapabilityLedger(readLedger(ledgerPath(repositoryRoot)), repositoryRoot)
  assert.deepEqual(result.findings, [])
  assert.equal(result.ok, true)
  assert.ok(result.counts.verified >= 1, 'at least one capability carries evidence')
  assert.ok(result.counts.unevidenced >= 1, 'the ledger also records a capability without evidence rather than hiding it')
})

test('a promise whose code path is missing is rejected', () => {
  assert.ok(ids(ledger([entry({ code: ['frontends/dsh/src/does-not-exist.ts'] })])).includes('entry-code-missing'))
})

test('a promise whose source or evidence path is missing is rejected', () => {
  assert.ok(ids(ledger([entry({ source: ['docs/does-not-exist.md'] })])).includes('entry-source-missing'))
  assert.ok(ids(ledger([entry({ evidence: ['frontends/dsh/tests/does-not-exist.test.mjs'] })])).includes('entry-evidence-missing'))
})

test('a capability cannot be verified without evidence', () => {
  assert.ok(ids(ledger([entry({ evidence: [] })])).includes('entry-verified-without-evidence'))
})

test('an unevidenced capability must state what is missing', () => {
  const silent = ids(ledger([entry({ status: 'unevidenced' })]))
  assert.ok(silent.includes('entry-unevidenced-without-reason'))
  const stated = checkCapabilityLedger(ledger([entry({ status: 'unevidenced', reason: 'No test asserts the save policy.' })]), repositoryRoot)
  assert.deepEqual(stated.findings, [])
  assert.equal(stated.counts.unevidenced, 1)
})

test('an entry with no code is rejected and a duplicate id is rejected', () => {
  assert.ok(ids(ledger([entry({ code: [] })])).includes('entry-missing-code'))
  assert.ok(ids(ledger([entry(), entry()])).includes('entry-duplicate-id'))
})

test('a platform outside the known set cannot be claimed', () => {
  assert.ok(ids(ledger([entry({ platforms: ['solaris-sparc'] })])).includes('entry-unknown-platform'))
})

test('a ledger with the wrong revision or no entries is rejected', () => {
  assert.ok(ids({ schemaVersion: 99, entries: [] }).includes('ledger-schema'))
  assert.ok(ids({ schemaVersion: LEDGER_SCHEMA_VERSION }).includes('ledger-schema'))
  assert.ok(ids({ entries: [] }).includes('ledger-schema'))
})
