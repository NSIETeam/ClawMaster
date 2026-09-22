import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { REVIEWED_PERMISSIONS, REVIEWED_WEBVIEWS, auditShellPosture, shellConfigPaths } from './shell-permission-posture.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** A fixture whose shell configuration can be perturbed one field at a time. */
function fixture(t, { csp, permissions, webviews } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shell-posture-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const shipped = shellConfigPaths(repositoryRoot)
  const confPath = join(root, 'tauri.conf.json')
  const capabilitiesDir = join(root, 'capabilities')
  mkdirSync(capabilitiesDir, { recursive: true })
  const shippedConf = JSON.parse(readFileSync(shipped.confPath, 'utf8'))
  const shippedCapability = JSON.parse(readFileSync(join(shipped.capabilitiesDir, 'default.json'), 'utf8'))
  if (csp !== undefined) shippedConf.app.security.csp = csp
  if (webviews !== undefined) shippedCapability.webviews = webviews
  if (permissions !== undefined) shippedCapability.permissions = permissions
  writeFileSync(confPath, JSON.stringify(shippedConf, null, 2))
  writeFileSync(join(capabilitiesDir, 'default.json'), JSON.stringify(shippedCapability, null, 2))
  return { confPath, capabilitiesDir }
}

test('the shipped shell grants only the reviewed WebView and native commands', () => {
  const audit = auditShellPosture(shellConfigPaths(repositoryRoot))
  assert.deepEqual(audit.findings, [])
  assert.equal(audit.ok, true)
  assert.deepEqual(audit.webviews, REVIEWED_WEBVIEWS)
  assert.deepEqual([...audit.permissions].sort(), [...REVIEWED_PERMISSIONS].sort())
  assert.equal(audit.csp['frame-src'], "'none'", 'no foreign frame can be embedded')
  assert.equal(audit.csp['connect-src'], 'ipc: http://ipc.localhost', 'the shell reaches only its own IPC')
})

test('a missing or wildcard content-security policy is rejected', t => {
  const missing = auditShellPosture(fixture(t, { csp: null }))
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.findings.map(finding => finding.id), ['csp-missing'])

  const wildcard = auditShellPosture(fixture(t, { csp: { 'default-src': "*", 'object-src': "'none'", 'frame-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self'" } }))
  assert.equal(wildcard.ok, false)
  assert.ok(wildcard.findings.some(finding => finding.id === 'csp-default-src-open'), 'a wildcard default source is refused')
})

test('inline script or eval allowances in the shell policy are rejected', t => {
  const shipped = JSON.parse(readFileSync(shellConfigPaths(repositoryRoot).confPath, 'utf8'))
  const csp = { ...shipped.app.security.csp, 'script-src': "'self' 'unsafe-inline' 'unsafe-eval'" }
  const audit = auditShellPosture(fixture(t, { csp }))
  assert.equal(audit.ok, false)
  const finding = audit.findings.find(entry => entry.id === 'csp-script-src-forbidden-source')
  assert.ok(finding, 'the inline and eval allowances are named')
  assert.match(finding.evidence, /unsafe-inline/)
  assert.match(finding.evidence, /unsafe-eval/)
})

test('a native command granted outside the reviewed posture is rejected', t => {
  const audit = auditShellPosture(fixture(t, { permissions: [...REVIEWED_PERMISSIONS, 'fs:allow-write-file'] }))
  assert.equal(audit.ok, false)
  const finding = audit.findings.find(entry => entry.id === 'capability-permission-unreviewed')
  assert.ok(finding, 'an unreviewed native command is named')
  assert.match(finding.evidence, /fs:allow-write-file/)
})

test('granting native commands to another WebView is rejected', t => {
  const audit = auditShellPosture(fixture(t, { webviews: ['main', 'host'] }))
  assert.equal(audit.ok, false)
  const finding = audit.findings.find(entry => entry.id === 'capability-webview-unreviewed')
  assert.ok(finding)
  assert.match(finding.evidence, /host/)
})

test('every accepted directive is required, not optional', t => {
  const shipped = JSON.parse(readFileSync(shellConfigPaths(repositoryRoot).confPath, 'utf8'))
  for (const directive of ['default-src', 'object-src', 'frame-src', 'base-uri', 'form-action']) {
    const csp = { ...shipped.app.security.csp }
    delete csp[directive]
    const audit = auditShellPosture(fixture(t, { csp }))
    assert.ok(audit.findings.some(finding => finding.id === `csp-${directive}-open`), `${directive} cannot be dropped`)
  }
})
