/** macOS acceptance checks run without launching an application or touching a real Harness home. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { acceptanceEnvironment, assertDisposableRunner, collectWindowGeometry, parseOptions, processIdentity, reapOwned, verifyMacosNativeEvidence, verifyWindowGeometry, watchOwnedDescendants, windowGeometryReadiness } from './verify-macos-native.mjs'

const runner = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
  RUNNER_TEMP: '/private/runner/temp', GITHUB_WORKSPACE: '/private/runner/work' }

function geometry(width = 1024, height = 684) {
  return {
    window: { x: 10, y: 30, width, height },
    buttons: ['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton'].map((subrole, index) => ({
      subrole, bounds: { x: 24 + index * 20, y: 38, width: 14, height: 14 },
    })),
    webAreas: [{ bounds: { x: 10, y: 60, width, height: height - 30 }, viewport: { x: 10, y: 60, width, height: height - 30 } }],
  }
}

test('macOS process identity preserves Unicode, spaces and hash characters in executable paths', {
  skip: process.platform !== 'darwin' ? 'macOS ps path rendering' : false, timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ClawMaster native 验收 # '))
  let child, finished
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (finished) await finished
    await rm(root, { recursive: true, force: true })
  })
  const copied = join(root, 'sleep')
  await copyFile('/bin/sleep', copied)
  const binary = await realpath(copied)
  child = spawn(binary, ['60'], { stdio: 'ignore', env: acceptanceEnvironment(process.env) })
  finished = once(child, 'exit')
  await once(child, 'spawn')
  const identity = await processIdentity(child.pid)
  assert.equal(identity.parentPid, process.pid)
  assert.equal(identity.path, binary)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
})

function fixture() {
  const bundle = { contentSha256: 'a'.repeat(64), buildProvenance: {
    mode: 'release', source: { dirty: false, dirtyFiles: [], gitCommit: 'b'.repeat(40) },
  } }
  const installedApp = '/private/runner/temp/验收 # 12/ClawMaster.app'
  const appDataRoot = '/Users/runner/Library/Application Support/DeepSeek Harness'
  const makeRun = (desktopPid, startedAtUnixMs) => ({
    desktopPid, hostPid: desktopPid + 1, hostParentPid: desktopPid,
    desktopPath: `${installedApp}/Contents/MacOS/dsh-desktop`, startedAtUnixMs,
    desktopAlive: true, hostAlive: true, httpStatus: 401,
    runtimeManifestSha256: 'c'.repeat(64), window: { visible: true, width: 1024, height: 684 },
    geometryChecks: [{ mode: 'normal', geometry: geometry() }, { mode: 'narrow', geometry: geometry(900, 600) }],
    closeMethod: 'AXCloseButton', closeRequested: true,
    desktopExited: true, hostExited: true, hostTerminatedByAcceptance: false,
    desktopExit: { code: 0, signal: null }, settingsMarkerPreserved: true, sessionMarkerPreserved: true,
    stopped: { status: 'stopped', runId: `${desktopPid}-${startedAtUnixMs}` },
    runtime: { schemaVersion: 1, status: 'ready', runId: `${desktopPid}-${startedAtUnixMs}`, desktopVersion: '0.2.2',
      desktopPid, hostPid: desktopPid + 1, observedAtUnixMs: startedAtUnixMs + 1,
      harnessRoot: `${appDataRoot}/harness-versions/abc`, disabledPlugins: [], ...structuredClone(bundle) },
  })
  return { bundle, evidence: { schemaVersion: 1, platform: 'darwin', closeMode: 'gui', installedProductVersion: '0.2.2',
    installedApp, appDataRoot, packagedManifestSha256: 'c'.repeat(64), preparedManifestSha256: 'c'.repeat(64),
    packagedContentSha256: bundle.contentSha256, nativeHelperVerified: true,
    runs: [makeRun(123, 100), makeRun(456, 200)] } }
}

test('preflight needs no app and GUI closing is the explicit default', () => {
  const options = parseOptions(['--preflight'])
  assert.equal(options.preflight, true)
  assert.equal(options.app, undefined)
  assert.equal(options.closeMode, 'gui')
  assert.equal(parseOptions(['--preflight', '--close-mode', 'terminate']).closeMode, 'terminate')
  for (const args of [[], ['--close-mode', 'auto', '--preflight'], ['--preflight', '--startup-timeout-seconds', '0'],
    ['--app', 'relative.app', '--prepared-root', '/build', '--expected-version', '0.2.2', '--output', '/result.json']]) {
    assert.throws(() => parseOptions(args))
  }
})

test('the runner guard refuses local, self-hosted and non-macOS execution', () => {
  assert.doesNotThrow(() => assertDisposableRunner(runner, 'darwin'))
  for (const [environment, platform] of [[{}, 'darwin'], [runner, 'linux'], [{ ...runner, GITHUB_ACTIONS: 'false' }, 'darwin'],
    [{ ...runner, RUNNER_ENVIRONMENT: 'self-hosted' }, 'darwin'], [{ ...runner, RUNNER_OS: 'Windows' }, 'darwin'],
    [{ ...runner, RUNNER_TEMP: 'relative' }, 'darwin']]) assert.throws(() => assertDisposableRunner(environment, platform))
})

test('the executable preflight refuses this test environment before contacting the desktop', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-macos-native.mjs', import.meta.url)), '--preflight'], {
    env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /only on disposable GitHub-hosted macOS/)
  assert.equal(result.stdout, '')
})

test('child launch removes credentials, source overrides and inherited Node hooks', () => {
  const original = { PATH: '/bin', HOME: '/Users/runner', API_KEY: 'private', GITHUB_TOKEN: 'private', password: 'private',
    DSH_DESKTOP_REPO: '/checkout', DSH_DESKTOP_LAUNCH: 'local', DSH_RUNTIME_RUN_ID: 'stale', NODE_OPTIONS: '--import external.mjs', DSH_HOME: '/old' }
  assert.deepEqual(acceptanceEnvironment(original, '/owned/home'), { PATH: '/bin', HOME: '/Users/runner', DSH_HOME: '/owned/home' })
  assert.deepEqual(acceptanceEnvironment(original, undefined), { PATH: '/bin', HOME: '/Users/runner' })
  assert.equal(original.DSH_HOME, '/old')
})

test('both GUI closes preserve packaged source, markers and owned Host teardown', () => {
  const { evidence, bundle } = fixture()
  const checked = verifyMacosNativeEvidence(evidence, bundle, '0.2.2')
  assert.equal(checked.runtimeVerified, true)
  assert.equal(checked.guiCloseVerified, true)
  assert.equal(checked.windowGeometryVerified, true)
})

test('macOS evidence keeps POSIX paths and exact directory ownership on every test host', () => {
  const { evidence, bundle } = fixture()
  assert.equal(verifyMacosNativeEvidence(evidence, bundle, '0.2.2').runtimeVerified, true)
  for (const mutate of [
    value => { value.runs[0].desktopPath = value.runs[0].desktopPath.replaceAll('/', '\\') },
    value => { value.runs[0].runtime.harnessRoot = value.runs[0].runtime.harnessRoot.replace('/Users/', '/users/') },
    value => { value.runs[0].runtime.harnessRoot = `${value.appDataRoot}/../other/runtime` },
    value => { value.runs[0].runtime.harnessRoot = value.appDataRoot },
    value => { value.runs[0].runtime.harnessRoot = 'C:\\Users\\runner\\harness-versions\\abc' },
    value => { value.installedApp = 'C:\\Applications\\ClawMaster.app' },
    value => { value.appDataRoot = 'C:\\Users\\runner\\AppData\\DeepSeek Harness' },
  ]) {
    const candidate = structuredClone(evidence)
    mutate(candidate)
    assert.throws(() => verifyMacosNativeEvidence(candidate, bundle, '0.2.2'))
  }
})

test('window geometry rejects overlapping or missing viewports and missing window buttons', () => {
  assert.doesNotThrow(() => verifyWindowGeometry(geometry()))
  const touchesEdge = geometry()
  touchesEdge.webAreas[0].viewport.y = 52
  assert.doesNotThrow(() => verifyWindowGeometry(touchesEdge))
  const fullscreen = geometry()
  fullscreen.buttons[2].subrole = 'AXFullScreenButton'
  assert.doesNotThrow(() => verifyWindowGeometry(fullscreen))
  for (const mutate of [
    value => { value.webAreas[0].viewport = { ...value.window } },
    value => { value.webAreas.push({ bounds: { ...value.window }, viewport: { ...value.window } }) },
    value => { value.webAreas[0].viewport = null },
    value => { value.webAreas = [] },
    value => { value.buttons.pop() },
    value => { value.buttons[1].subrole = 'AXCloseButton' },
    value => { value.webAreas[0].viewport.width = 0 },
    value => { value.webAreas[0].bounds.y = NaN },
    value => { value.webAreas[0].viewport.height = Infinity },
    value => { value.webAreas[0].viewport.x = value.window.x - 1 },
    value => { value.buttons[0].bounds.x = value.window.x - 1 },
  ]) {
    const value = geometry()
    mutate(value)
    assert.throws(() => verifyWindowGeometry(value))
  }
})

test('long and scrolled documents may extend beyond a correctly clipped native viewport', () => {
  const value = geometry()
  value.webAreas[0].bounds = { x: -100, y: -2000, width: 1400, height: 10000 }
  assert.doesNotThrow(() => verifyWindowGeometry(value))
  value.webAreas[0].viewport.y = value.window.y
  assert.throws(() => verifyWindowGeometry(value), /overlaps a native window button/)
})

test('resize readiness waits for a delayed viewport and requires consecutive valid observations', () => {
  const check = {}, ready = windowGeometryReadiness(check, { width: 900, height: 600 })
  const observed = value => ({ window: { visible: true }, geometry: value })
  const previousSize = geometry()
  const staleViewport = geometry(900, 600)
  staleViewport.webAreas[0].viewport = previousSize.webAreas[0].viewport
  assert.equal(ready(observed(previousSize)), false)
  assert.equal(ready(observed(staleViewport)), false)
  assert.equal(ready(observed(staleViewport)), false)
  assert.match(check.validationError, /outside its main window/)
  assert.deepEqual(check.geometry, staleViewport)
  const resized = geometry(900, 600)
  assert.equal(ready(observed(resized)), false)
  assert.equal(check.validationError, null)
  assert.equal(ready(observed(staleViewport)), false)
  assert.equal(ready(observed(resized)), false)
  assert.equal(ready(observed(resized)), true)
  assert.equal(check.validationError, null)
})

test('geometry readiness retains overlap diagnostics and does not swallow unexpected failures', () => {
  const check = {}, ready = windowGeometryReadiness(check, { width: 900, height: 600 })
  const overlapping = geometry(900, 600)
  overlapping.webAreas[0].viewport = { ...overlapping.window }
  const observed = { window: { visible: true }, geometry: overlapping }
  assert.equal(ready(observed), false)
  assert.equal(ready(observed), false)
  assert.match(check.validationError, /overlaps a native window button/)
  assert.deepEqual(check.geometry, overlapping)
  const failure = new Error('Unexpected observation failure')
  assert.throws(() => ready({ get geometry() { throw failure } }), error => error === failure)
  assert.throws(() => ready({ ...observed, geometryError: 'Missing unique native button' }), /geometry collection failed/)
  assert.equal(check.error, 'Missing unique native button')
})

test('geometry collection stops at every WebArea without reading page or window text', () => {
  const expected = geometry(), visited = []
  const element = (role, bounds, children = []) => new Proxy({
    role: () => { visited.push(role); return role },
    position: () => [bounds.x, bounds.y], size: () => [bounds.width, bounds.height],
    uiElements: () => { assert.notEqual(role, 'AXWebArea', 'Page children must remain unread'); return children },
  }, {
    get: (target, name) => { assert.ok(name in target, `Unexpected accessibility property: ${String(name)}`); return target[name] },
  })
  const secondArea = { bounds: { x: -20, y: -1000, width: 2000, height: 5000 }, viewport: { x: 400, y: 60, width: 300, height: 300 } }
  expected.webAreas.push(secondArea)
  const tree = element('AXWindow', expected.window, [
    element('AXScrollArea', expected.webAreas[0].viewport, [element('AXGroup', expected.window, [element('AXWebArea', expected.webAreas[0].bounds)])]),
    element('AXScrollArea', expected.window, [element('AXScrollArea', secondArea.viewport, [element('AXWebArea', secondArea.bounds)])]),
  ])
  tree.buttons = { whose: ({ subrole }) => () => {
    const match = expected.buttons.find(button => button.subrole === subrole)
    return match ? [element('AXButton', match.bounds)] : []
  } }
  assert.deepEqual(collectWindowGeometry(tree), expected)
  assert.deepEqual(visited, ['AXWindow', 'AXScrollArea', 'AXScrollArea', 'AXGroup', 'AXScrollArea', 'AXWebArea', 'AXWebArea'])
  assert.doesNotThrow(() => verifyWindowGeometry(expected))
  expected.buttons[2].subrole = 'AXFullScreenButton'
  assert.deepEqual(collectWindowGeometry(tree), expected)
  const missing = element('AXWindow', expected.window, [element('AXWebArea', expected.webAreas[0].bounds)])
  missing.buttons = tree.buttons
  const incomplete = collectWindowGeometry(missing)
  assert.equal(incomplete.webAreas[0].viewport, null)
  assert.throws(() => verifyWindowGeometry(incomplete), /no observed native scroll viewport/)
})

test('geometry collection refuses unbounded or ambiguous accessibility trees', () => {
  const rect = { position: () => [0, 0], size: () => [1024, 684] }
  const buttons = { whose: ({ subrole }) => () => subrole === 'AXFullScreenButton' ? [] : [rect] }
  const cycle = { ...rect, buttons, role: () => 'AXGroup', uiElements: () => [cycle] }
  assert.throws(() => collectWindowGeometry(cycle), error => {
    assert.match(error.message, /depth limit/)
    assert.equal(error.geometry.buttons.length, 3)
    assert.deepEqual(error.geometry.window, { x: 0, y: 0, width: 1024, height: 684 })
    return true
  })
  const broad = { ...rect, buttons, role: () => 'AXWindow',
    uiElements: () => Array.from({ length: 256 }, () => ({ ...rect, role: () => 'AXWebArea' })) }
  assert.throws(() => collectWindowGeometry(broad), /traversal limit/)
  assert.throws(() => collectWindowGeometry({ ...cycle, buttons: { whose: () => () => [rect, rect] } }), /no unique AXCloseButton/)
  assert.throws(() => collectWindowGeometry({ ...cycle, buttons: { whose: () => () => [rect] } }), /no unique AXZoomButton\/AXFullScreenButton/)
})

test('both launches require normal and resized non-overlapping window evidence', () => {
  for (const mutate of [
    e => { e.runs[1].geometryChecks = [] },
    e => { e.runs[0].geometryChecks.reverse() },
    e => { e.runs[0].geometryChecks[0].geometry = geometry(900, 600) },
    e => { e.runs[0].geometryChecks[1].geometry = geometry(1024, 684) },
    e => { e.runs[0].geometryChecks[1].geometry = geometry(900, 599) },
    e => { e.runs[0].geometryChecks[1].error = 'incomplete collection' },
    e => { e.runs[0].geometryChecks[1].validationError = 'viewport did not settle' },
    e => { const value = e.runs[1].geometryChecks[1].geometry; value.webAreas[0].viewport = { ...value.window } },
  ]) {
    const { evidence, bundle } = fixture()
    mutate(evidence)
    assert.throws(() => verifyMacosNativeEvidence(evidence, bundle, '0.2.2'))
  }
})

test('stale identity, another build, lost markers and incomplete teardown fail acceptance', () => {
  for (const mutate of [
    e => { e.runs[1].runtime.runId = e.runs[0].runtime.runId },
    e => { e.runs[0].runtime.desktopPid++ }, e => { e.runs[0].runtime.hostPid++ },
    e => { e.runs[0].hostParentPid++ }, e => { e.runs[0].runtime.observedAtUnixMs = 1 },
    e => { e.runs[0].desktopPath = '/Applications/ClawMaster.app/Contents/MacOS/dsh-desktop' },
    e => { e.runs[0].runtime.harnessRoot = `${e.appDataRoot}-other/runtime` },
    e => { e.runs[0].desktopAlive = false }, e => { e.runs[0].hostAlive = false },
    e => { e.runs[0].runtime.disabledPlugins = ['failed-plugin'] }, e => { e.runs[0].httpStatus = 200 },
    e => { e.runs[0].runtime.contentSha256 = 'd'.repeat(64) },
    e => { e.runs[0].runtime.buildProvenance.source.gitCommit = 'e'.repeat(40) },
    e => { e.packagedManifestSha256 = 'f'.repeat(64) }, e => { e.runs[0].runtimeManifestSha256 = 'f'.repeat(64) },
    e => { e.packagedContentSha256 = 'f'.repeat(64) }, e => { e.nativeHelperVerified = false },
    e => { e.runs[0].settingsMarkerPreserved = false }, e => { e.runs[0].sessionMarkerPreserved = false },
    e => { e.runs[0].desktopExited = false }, e => { e.runs[0].hostExited = false },
    e => { e.runs[0].stopped.runId = 'another-run' }, e => { e.runs[0].stopped.status = 'ready' },
    e => { e.runs[0].window.width = 520 }, e => { e.runs[0].window.visible = false },
    e => { e.runs[0].closeRequested = false }, e => { e.runs[0].desktopExit.code = 1 },
    e => { e.runs[0].desktopExit.signal = 'SIGTERM' }, e => { e.runs[0].hostTerminatedByAcceptance = true },
  ]) {
    const { evidence, bundle } = fixture()
    mutate(evidence)
    assert.throws(() => verifyMacosNativeEvidence(evidence, bundle, '0.2.2'))
  }
})

test('dirty or mismatched native versions are refused', () => {
  for (const mutate of [b => { b.buildProvenance.source.dirty = true }, b => { b.buildProvenance.source.dirtyFiles = ['edited.ts'] },
    b => { b.buildProvenance.mode = 'development' }]) {
    const { evidence, bundle } = fixture()
    mutate(bundle)
    assert.throws(() => verifyMacosNativeEvidence(evidence, bundle, '0.2.2'))
  }
  const { evidence, bundle } = fixture()
  assert.throws(() => verifyMacosNativeEvidence(evidence, bundle, '0.2.3'))
})

test('explicit SIGTERM evidence verifies restart only and cannot claim a GUI close', () => {
  const { evidence, bundle } = fixture()
  evidence.closeMode = 'terminate'
  for (const run of evidence.runs) {
    run.closeMethod = 'SIGTERM'; run.desktopExit = { code: null, signal: 'SIGTERM' }
    run.window = null; run.closeRequested = false; run.hostTerminatedByAcceptance = true
    run.stopped.status = 'ready'
  }
  const checked = verifyMacosNativeEvidence(evidence, bundle, '0.2.2')
  assert.equal(checked.runtimeVerified, true)
  assert.equal(checked.guiCloseVerified, false)
  assert.equal(checked.windowGeometryVerified, false)
  evidence.closeMode = 'gui'
  assert.throws(() => verifyMacosNativeEvidence(evidence, bundle, '0.2.2'))
})

test('cleanup leaves a changed identity alone and waits for its owned child to exit', { skip: process.platform === 'win32' }, async t => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(() => {}, 1000); process.send("ready")'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: acceptanceEnvironment(process.env, undefined),
  })
  const finished = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await finished
  })
  await once(child, 'message')
  const identity = await processIdentity(child.pid)
  assert.equal(identity.parentPid, process.pid)
  assert.equal(await reapOwned({ ...identity, started: 'different creation time' }), false)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  assert.equal(await reapOwned(identity), true)
  const [code, signal] = await finished
  assert.equal(code, null)
  assert.equal(signal, 'SIGTERM')
  assert.equal(await processIdentity(child.pid), null)
})

test('natural exit between identity observation and signaling is already complete', async () => {
  const identity = { pid: 123, started: 'observed creation', path: '/owned/helper' }
  let observed = false
  assert.equal(await reapOwned(identity, {
    inspect: async pid => { assert.equal(pid, identity.pid); observed = true; return identity },
    signal: (pid, signal) => {
      assert.equal(observed, true)
      assert.equal(pid, identity.pid)
      assert.equal(signal, 'SIGTERM')
      throw Object.assign(new Error('Process exited after observation'), { code: 'ESRCH' })
    },
  }), false)
  await assert.rejects(reapOwned(identity, {
    inspect: async () => identity,
    signal: () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }) },
  }), /Permission denied/)
})

test('descendant tracking retains children after parent exit and awaits an in-flight scan on stop', async t => {
  const ancestor = { pid: 123, started: 'parent creation', path: '/owned/desktop' }
  const child = { pid: 456, parentPid: 123, started: 'child creation', path: '/owned/host' }
  const secondScan = Promise.withResolvers(), finishScan = Promise.withResolvers()
  let scans = 0
  const tracker = watchOwnedDescendants(ancestor, {
    scan: async observed => {
      scans++
      if (scans === 1) { assert.deepEqual(observed, [ancestor]); return [child] }
      assert.deepEqual(observed, [ancestor, child])
      secondScan.resolve()
      // The parent has exited: discovery cannot reconstruct its previous children.
      await finishScan.promise
      return []
    },
  })
  t.after(async () => { finishScan.resolve(); await tracker.stop() })
  await secondScan.promise
  assert.deepEqual(tracker.captured(), [child])
  let stopped = false
  const stopping = tracker.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  finishScan.resolve()
  await stopping
  await tracker.stop()
  assert.equal(scans, 2)
  assert.deepEqual(tracker.captured(), [child])
})

test('a failed descendant scan is retained and reported when polling stops', async () => {
  const failure = new Error('Process snapshot unavailable')
  const tracker = watchOwnedDescendants({ pid: 123, started: 'parent creation', path: '/owned/desktop' }, {
    scan: async () => { throw failure },
  })
  await assert.rejects(tracker.stop(), error => error === failure)
  await assert.rejects(tracker.stop(), error => error === failure)
  assert.deepEqual(tracker.captured(), [])
})
