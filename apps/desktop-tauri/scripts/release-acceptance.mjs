/** Validate platform-specific installed-release evidence before a candidate can be published. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpathSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Required installer lanes; Android has its own capability and scenario requirements. */
export const ACCEPTANCE_TARGETS = Object.freeze({
  'macos-arm64-dmg': { platform: 'darwin', architecture: 'arm64', signature: 'developer-id-notarized', extension: '.dmg' },
  'windows-x64-nsis': { platform: 'win32', architecture: 'x64', signature: 'authenticode', extension: '.exe' },
  'linux-x64-appimage': { platform: 'linux', architecture: 'x64', signature: 'minisign', extension: '.AppImage' },
  'linux-x64-deb': { platform: 'linux', architecture: 'x64', signature: 'minisign', extension: '.deb' },
  'android-universal-apk': { platform: 'android', architecture: 'universal', signature: 'android-apk', extension: '.apk' },
})
/** The explicitly narrower beta installer matrix; stable releases retain ACCEPTANCE_TARGETS. */
export const BETA_ACCEPTANCE_TARGETS = Object.freeze({
  'macos-arm64-dmg': ACCEPTANCE_TARGETS['macos-arm64-dmg'],
  'windows-x64-nsis': ACCEPTANCE_TARGETS['windows-x64-nsis'],
})

/** @param {string} version @returns {typeof ACCEPTANCE_TARGETS} Installed target matrix selected by the exact program version. */
export function acceptanceTargetsForVersion(version) {
  return /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/u.test(version) ? BETA_ACCEPTANCE_TARGETS : ACCEPTANCE_TARGETS
}

const COMMON_SCENARIOS = ['install', 'first-start-clean-user', 'network-failure-recovery', 'exit-restart', 'upgrade-data-preservation', 'uninstall-data-policy']
const DESKTOP_SCENARIOS = [...COMMON_SCENARIOS, 'unicode-space-path', 'update-rollback', 'optional-component-failure-recovery', 'approval-allow', 'approval-deny', 'cancel-task', 'write-failure-no-commit']
const ANDROID_SCENARIOS = [...COMMON_SCENARIOS, 'approval-allow', 'approval-deny', 'cancel-task', 'conversation-persistence']
const DESKTOP_INTEGRATIONS = [
  'real-model', 'office-save', 'wechat-selected-read', 'native-rpa-browser-click',
  'im-weixin-ui', 'im-feishu-ui', 'im-dingtalk-ui', 'im-qq-ui', 'im-wecom-ui',
]
const IM_UI_INTEGRATIONS = new Set(['im-weixin-ui', 'im-feishu-ui', 'im-dingtalk-ui', 'im-qq-ui', 'im-wecom-ui'])
const sha256Pattern = /^[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u
const statuses = ['passed', 'failed', 'blocked', 'not-run']

function object(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}
function nonempty(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.trim().length > 0, `${label} must not be empty`)
  return value
}

/** Start an honest, incomplete matrix for a particular candidate.
 * @param {string} version Candidate product version.
 * @param {string} sourceCommit Full candidate Git commit.
 * @param {string[]} supportedUpgradeVersions Explicitly supported historical versions.
 * @returns {object} A manifest with every installer marked not-run; no test evidence is invented.
 */
export function createAcceptanceTemplate(version, sourceCommit, supportedUpgradeVersions) {
  assert.match(sourceCommit, commitPattern)
  nonempty(version, 'Candidate version')
  assert.ok(Array.isArray(supportedUpgradeVersions) && supportedUpgradeVersions.length > 0)
  return { schemaVersion: 1, version, sourceCommit, supportedUpgradeVersions,
    targets: Object.fromEntries(Object.keys(acceptanceTargetsForVersion(version)).map(target => [target, { status: 'not-run', reason: 'Installed candidate acceptance has not been collected for this target' }])) }
}
async function fileWithin(root, file) {
  assert.equal(typeof file, 'string', 'Evidence file path must be a string')
  assert.ok(!isAbsolute(file) && file !== '' && !file.includes('\\') && !file.split('/').some(part => part === '' || part === '.' || part === '..'), 'Evidence paths must stay within the selected directory')
  let cursor = root
  for (const segment of file.split('/')) {
    cursor = join(cursor, segment)
    const info = await lstat(cursor)
    assert.equal(info.isSymbolicLink(), false, 'Evidence paths must not contain symbolic links')
  }
  const info = await lstat(cursor)
  assert.ok(info.isFile() && info.size > 0, 'Evidence must name a nonempty regular file')
  return { path: cursor, size: info.size }
}
async function verifiedFile(root, descriptor) {
  object(descriptor, 'File descriptor')
  assert.match(descriptor.sha256 ?? '', sha256Pattern, 'Evidence SHA-256 is required')
  const { path } = await fileWithin(root, descriptor.file)
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  assert.equal(hash.digest('hex'), descriptor.sha256, `Evidence digest differs: ${descriptor.file}`)
  return path
}
async function evidenceFiles(root, result, label) {
  assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0, `${label} needs independently retained evidence files`)
  for (const file of result.evidence) await verifiedFile(root, file)
}

/** Check completeness and integrity of retained evidence; native scripts and reviewers establish its truth.
 * @param {object} manifest Collected per-installer acceptance results.
 * @param {{root: string, expectedCommit: string, expectedVersion: string, requireComplete?: boolean}} options Exact candidate and retained artifact root.
 * @returns {Promise<object>} Readiness plus explicit incomplete items. Throws for contradictory or tampered evidence.
 */
export async function verifyReleaseAcceptance(manifest, options) {
  object(manifest, 'Acceptance manifest')
  assert.equal(manifest.schemaVersion, 1)
  assert.match(options.expectedCommit, commitPattern, 'Expected candidate commit must be a full SHA')
  assert.equal(manifest.sourceCommit, options.expectedCommit, 'Acceptance belongs to another source commit')
  assert.equal(manifest.version, options.expectedVersion, 'Acceptance belongs to another release version')
  const root = resolve(options.root)
  const rootInfo = await lstat(root)
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Evidence root must be a real directory')
  assert.ok(Array.isArray(manifest.supportedUpgradeVersions) && manifest.supportedUpgradeVersions.length > 0, 'Supported upgrade versions must be enumerated')
  assert.equal(new Set(manifest.supportedUpgradeVersions).size, manifest.supportedUpgradeVersions.length, 'Upgrade support versions must be unique')
  for (const version of manifest.supportedUpgradeVersions) assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  object(manifest.targets, 'Acceptance targets')
  const targets = acceptanceTargetsForVersion(manifest.version)
  assert.deepEqual(Object.keys(manifest.targets).sort(), Object.keys(targets).sort(), 'Every supported installer needs its own acceptance lane; Intel Mac is not a release target')
  const incomplete = []
  const artifacts = new Set()
  for (const [target, policy] of Object.entries(targets)) {
    const lane = object(manifest.targets[target], target)
    assert.ok(statuses.includes(lane.status), `${target} has an invalid status`)
    if (lane.status !== 'passed') {
      incomplete.push(`${target}: ${lane.status}: ${nonempty(lane.reason, `${target} reason`)}`)
      continue
    }
    assert.equal(lane.platform, policy.platform, `${target} cannot borrow another platform's result`)
    assert.equal(lane.architecture, policy.architecture, `${target} architecture differs`)
    nonempty(lane.osVersion, `${target} OS version`)
    assert.ok(['clean-user', 'clean-vm', 'clean-device'].includes(lane.environment), `${target} must use a clean user or system`)
    assert.equal(lane.installedVersion, manifest.version, `${target} installed a different version`)
    assert.equal(lane.sourceCommit, manifest.sourceCommit, `${target} source differs`)
    assert.ok(lane.artifact?.file?.endsWith(policy.extension), `${target} installer format differs`)
    assert.equal(artifacts.has(lane.artifact.file), false, 'One installer artifact cannot stand for two lanes')
    artifacts.add(lane.artifact.file)
    await verifiedFile(root, lane.artifact)
    object(lane.signature, `${target} signature`)
    assert.equal(lane.signature.kind, policy.signature, `${target} requires operating-system publisher verification, not a substitute signature`)
    assert.equal(lane.signature.status, 'passed', `${target} signing or notarization is not verified`)
    nonempty(lane.signature.publisher, `${target} publisher identity`)
    await evidenceFiles(root, lane.signature, `${target} signature`)
    object(lane.scenarios, `${target} scenarios`)
    for (const scenario of policy.platform === 'android' ? ANDROID_SCENARIOS : DESKTOP_SCENARIOS) {
      const result = object(lane.scenarios[scenario], `${target}/${scenario}`)
      assert.ok(statuses.includes(result.status), `${target}/${scenario} has an invalid status`)
      if (result.status !== 'passed') incomplete.push(`${target}/${scenario}: ${result.status}: ${nonempty(result.reason, 'Scenario reason')}`)
      else await evidenceFiles(root, result, `${target}/${scenario}`)
    }
    object(lane.upgrades, `${target} upgrade matrix`)
    for (const version of manifest.supportedUpgradeVersions) {
      const result = object(lane.upgrades[version], `${target} upgrade from ${version}`)
      if (result.status !== 'passed') incomplete.push(`${target}/upgrade/${version}: ${nonempty(result.reason, 'Upgrade reason')}`)
      else {
        for (const field of ['settings', 'credentials', 'sessions', 'businessData']) assert.equal(result.preserved?.[field], true, `${target} upgrade must retain ${field}`)
        await evidenceFiles(root, result, `${target}/upgrade/${version}`)
      }
    }
    object(lane.integrations, `${target} integrations`)
    for (const integration of policy.platform === 'android' ? ['real-model'] : DESKTOP_INTEGRATIONS) {
      const result = object(lane.integrations[integration], `${target}/${integration}`)
      assert.ok(statuses.includes(result.status), `${target}/${integration} has an invalid status`)
      assert.ok(['available', 'experimental', 'unavailable'].includes(result.availability), `${target}/${integration} availability must be explicit`)
      if (['real-model', 'native-rpa-browser-click'].includes(integration) && result.status !== 'passed') {
        incomplete.push(`${target}/${integration}: no successful installed integration`)
      }
        if (IM_UI_INTEGRATIONS.has(integration)) {
        if (result.status !== 'passed') incomplete.push(`${target}/${integration}: blocked-state UI behavior was not verified`)
        else {
          assert.ok(['available', 'unavailable'].includes(result.availability), `${integration} availability must be available or unavailable`)
          if (result.availability === 'unavailable') {
            assert.equal(result.uiState, 'blocked', `${integration} must show a blocked state when no connector is configured`)
            nonempty(result.reason, `${integration} blocked reason`)
          } else {
            assert.equal(result.uiState, 'connected', `${integration} claims availability without a connected UI state`)
            assert.equal(result.testAccountConsent, true, `${integration} needs explicit test-account consent`)
            nonempty(result.clientVersion, `${integration} tested client version`)
          }
          await evidenceFiles(root, result, `${target}/${integration}`)
        }
      }
      if (integration === 'native-rpa-browser-click' && result.status === 'passed') {
        assert.equal(result.availability, 'available', `${integration} must execute in the installed candidate`)
        nonempty(result.browserVersion, `${integration} tested browser version`)
      }
      if (result.status === 'passed') {
        if (integration === 'real-model') {
          const credentialStore = {
            darwin: 'macos-keychain', win32: 'windows-credential-manager', linux: 'linux-secret-service', android: 'android-keystore',
          }[policy.platform]
          assert.equal(result.credentialStore, credentialStore, `${target} real-model must resolve its key from the OS secure credential store`)
        }
        if (integration === 'wechat-selected-read') {
          assert.equal(result.testAccountConsent, true, `${integration} needs explicit test-account consent`)
          nonempty(result.clientVersion, `${integration} tested client version`)
        }
        if (!IM_UI_INTEGRATIONS.has(integration)) await evidenceFiles(root, result, `${target}/${integration}`)
      } else {
        nonempty(result.reason, `${integration} unverified reason`)
        if (result.availability === 'available') incomplete.push(`${target}/${integration}: advertised available without passing integration evidence`)
      }
    }
  }
  const result = { schemaVersion: 1, version: manifest.version, sourceCommit: manifest.sourceCommit, ready: incomplete.length === 0, incomplete }
  if (options.requireComplete !== false) assert.ok(result.ready, `Release acceptance is incomplete:\n${incomplete.join('\n')}`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, root: { type: 'string' }, commit: { type: 'string' }, version: { type: 'string' },
    template: { type: 'boolean', default: false }, 'upgrade-from': { type: 'string', multiple: true }, 'report-only': { type: 'boolean', default: false } } })
  assert.ok(values.commit && values.version && (values.manifest || values.template), 'Required: --manifest <file> --commit <full SHA> --version <version> [--root <artifact root>] or --template --upgrade-from <old version>')
  let result
  if (values.template) result = createAcceptanceTemplate(values.version, values.commit, values['upgrade-from'] ?? [])
  else {
    const manifestPath = resolve(values.manifest)
    const info = await lstat(manifestPath)
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024, 'Acceptance manifest must be a bounded regular file')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    result = await verifyReleaseAcceptance(manifest, { root: values.root ?? dirname(manifestPath), expectedCommit: values.commit, expectedVersion: values.version, requireComplete: !values['report-only'] })
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
