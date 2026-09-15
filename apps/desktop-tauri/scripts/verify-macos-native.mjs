/** Exercise a copied macOS desktop on a disposable Actions runner, without changing TCC permissions. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const execute = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part) }
const statOrMissing = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })

/** Validate CLI options without opening files or launching an application.
 * @param {string[]} args Arguments after the script name.
 * @returns {object} Explicit acceptance mode and required paths, or a preflight-only request.
 */
export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    app: { type: 'string' }, 'prepared-root': { type: 'string' }, 'expected-version': { type: 'string' },
    output: { type: 'string' }, 'startup-timeout-seconds': { type: 'string', default: '600' },
    'close-mode': { type: 'string', default: 'gui' }, preflight: { type: 'boolean', default: false },
  } })
  assert.ok(['gui', 'terminate'].includes(values['close-mode']), 'close-mode must be gui or terminate')
  const timeout = Number(values['startup-timeout-seconds'])
  assert.ok(Number.isInteger(timeout) && timeout >= 60 && timeout <= 1200, 'Startup timeout must be 60..1200 seconds')
  if (!values.preflight) {
    for (const name of ['app', 'prepared-root', 'output']) assert.ok(values[name] && isAbsolute(values[name]), `${name} must be an absolute path`)
    assert.match(values['expected-version'] ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected application version is required')
  }
  return { app: values.app, preparedRoot: values['prepared-root'], version: values['expected-version'], output: values.output,
    timeoutMs: timeout * 1000, closeMode: values['close-mode'], preflight: values.preflight }
}

/** Refuse local and self-hosted machines before any filesystem mutation or process launch.
 * @param {object} environment Runner environment variables.
 * @param {string} platform Node platform name.
 * @returns {void}
 */
export function assertDisposableRunner(environment, platform) {
  assert.ok(platform === 'darwin' && environment.GITHUB_ACTIONS === 'true' && environment.RUNNER_ENVIRONMENT === 'github-hosted'
    && environment.RUNNER_OS === 'macOS', 'Native acceptance runs only on disposable GitHub-hosted macOS runners')
  for (const name of ['RUNNER_TEMP', 'GITHUB_WORKSPACE']) assert.ok(environment[name] && isAbsolute(environment[name]), `${name} must be an absolute runner directory`)
}

/** Remove credentials and source-launch overrides from child environments.
 * @param {object} environment Parent environment.
 * @param {string | undefined} dshHome Isolated Harness home, omitted for inspection subprocesses.
 * @returns {object} Environment for the copied desktop and its subprocesses.
 */
export function acceptanceEnvironment(environment, dshHome) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)
    && !/^DSH_(?:DESKTOP|RUNTIME)/.test(key) && key !== 'NODE_OPTIONS' && key !== 'DSH_HOME')),
    ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }) }
}

function verifyBundle(bundle) {
  assert.match(bundle.contentSha256, /^[a-f0-9]{64}$/)
  assert.equal(bundle.buildProvenance.mode, 'release')
  assert.equal(bundle.buildProvenance.source.dirty, false)
  assert.deepEqual(bundle.buildProvenance.source.dirtyFiles, [])
  assert.match(bundle.buildProvenance.source.gitCommit, /^[a-f0-9]{40}$/)
}

/** Validate collected evidence; process termination never qualifies as normal GUI closing.
 * @param {object} evidence Observations from two owned application launches.
 * @param {object} bundle Prepared release manifest.
 * @param {string} version Expected native version.
 * @returns {object} Evidence with separate runtime and GUI verification results.
 */
export function verifyMacosNativeEvidence(evidence, bundle, version) {
  verifyBundle(bundle)
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.platform, 'darwin')
  assert.ok(['gui', 'terminate'].includes(evidence.closeMode))
  assert.equal(evidence.installedProductVersion, version)
  assert.equal(evidence.packagedManifestSha256, evidence.preparedManifestSha256)
  assert.match(evidence.packagedManifestSha256, /^[a-f0-9]{64}$/)
  assert.equal(evidence.packagedContentSha256, bundle.contentSha256)
  assert.equal(evidence.nativeHelperVerified, true)
  assert.equal(evidence.runs.length, 2)
  assert.notEqual(evidence.runs[0].runtime.runId, evidence.runs[1].runtime.runId, 'Relaunch must publish a new run')
  for (const run of evidence.runs) {
    const runtime = run.runtime
    assert.equal(runtime.schemaVersion, 1)
    assert.equal(runtime.status, 'ready')
    assert.match(runtime.runId, /^\S+$/)
    assert.equal(runtime.desktopVersion, version)
    assert.equal(runtime.desktopPid, run.desktopPid)
    assert.equal(runtime.hostPid, run.hostPid)
    assert.equal(run.hostParentPid, run.desktopPid, 'Host must be owned by this desktop')
    assert.equal(run.desktopPath, join(evidence.installedApp, 'Contents/MacOS/dsh-desktop'))
    assert.equal(run.desktopAlive, true)
    assert.equal(run.hostAlive, true)
    assert.ok(inside(evidence.appDataRoot, runtime.harnessRoot), 'Running payload escaped the owned application-data directory')
    assert.ok(runtime.observedAtUnixMs >= run.startedAtUnixMs, 'Ready record predates this launch')
    assert.equal(run.httpStatus, 401)
    assert.deepEqual(runtime.disabledPlugins, [])
    assert.equal(runtime.contentSha256, bundle.contentSha256)
    assert.deepEqual(runtime.buildProvenance, bundle.buildProvenance)
    assert.equal(run.runtimeManifestSha256, evidence.packagedManifestSha256)
    assert.equal(run.desktopExited, true)
    assert.equal(run.hostExited, true)
    assert.equal(run.settingsMarkerPreserved, true)
    assert.equal(run.sessionMarkerPreserved, true)
    if (evidence.closeMode === 'gui') {
      assert.equal(run.closeMethod, 'AXCloseButton')
      assert.equal(run.closeRequested, true)
      assert.equal(run.window.visible, true)
      assert.ok(run.window.width >= 800 && run.window.height >= 600, 'Splash cannot substitute for the main window')
      assert.equal(run.desktopExit.code, 0)
      assert.equal(run.desktopExit.signal, null)
      assert.equal(run.hostTerminatedByAcceptance, false)
      assert.equal(run.stopped.status, 'stopped')
      assert.equal(run.stopped.runId, runtime.runId)
    } else {
      assert.equal(run.closeMethod, 'SIGTERM')
      assert.equal(run.desktopExit.signal, 'SIGTERM')
    }
  }
  return { ...evidence, runtimeVerified: true, guiCloseVerified: evidence.closeMode === 'gui' }
}

// System osascript is covered by the runner image's existing Accessibility and System Events grants.
const JXA = `ObjC.import('ApplicationServices');
function run(args) {
  var trusted = Boolean($.AXIsProcessTrusted());
  if (!trusted) return JSON.stringify({axTrusted:false,guiAvailable:false});
  var system = Application('System Events');
  if (args[0] === 'preflight') return JSON.stringify({axTrusted:true,guiAvailable:system.processes().length > 0});
  var matches = system.processes.whose({unixId:Number(args[1])})();
  if (matches.length !== 1) return JSON.stringify({axTrusted:true,window:null});
  var process = matches[0], windows = process.windows();
  for (var i = 0; i < windows.length; i++) {
    var size = windows[i].size();
    if (size[0] < 800 || size[1] < 600) continue;
    var result = {axTrusted:true,window:{width:size[0],height:size[1],visible:process.visible()}};
    if (args[0] === 'close') {
      var buttons = windows[i].buttons.whose({subrole:'AXCloseButton'})();
      if (buttons.length !== 1) throw Error('Main window has no unique close button');
      buttons[0].click(); result.closeRequested = true;
    }
    return JSON.stringify(result);
  }
  return JSON.stringify({axTrusted:true,window:null});
}`

async function command(file, args, options = {}) {
  try { return (await execute(file, args, { timeout: 15000, maxBuffer: 1024 * 1024,
    env: acceptanceEnvironment(process.env, process.env.DSH_HOME), ...options })).stdout.trim() }
  catch { throw new Error(`Native acceptance command failed: ${basename(file)} (timeout, exit, or unavailable permission)`) }
}

async function gui(mode, pid) {
  const value = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, mode, ...(pid === undefined ? [] : [String(pid)])]))
  assert.equal(value.axTrusted, true, 'Runner osascript lacks existing Accessibility permission; TCC is not changed')
  return value
}

/** Observe a PID's creation time and executable before treating it as owned.
 * @param {number} pid Positive process id.
 * @returns {Promise<object | null>} Process identity, or null after exit.
 */
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid owned process id')
  try {
    const { stdout } = await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='], {
      // macOS ps escapes non-ASCII paths under C; English UTF-8 also keeps the start time stable.
      timeout: 5000, env: { ...acceptanceEnvironment(process.env, process.env.DSH_HOME), LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C' },
    })
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/u.exec(stdout)
    assert.ok(match, 'Unexpected process identity output')
    return { pid, parentPid: Number(match[1]), started: match[2].replace(/\s+/g, ' '), path: match[3] }
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return null
    throw error
  }
}

const sameIdentity = (current, observed) => current && current.started === observed.started && current.path === observed.path

async function descendantsOf(ancestors) {
  const output = await command('/bin/ps', ['-axo', 'pid=', '-o', 'ppid='])
  const pairs = output.split('\n').map(line => line.trim().split(/\s+/).map(Number))
  const parents = new Map(), result = []
  for (const ancestor of ancestors) {
    if (sameIdentity(await processIdentity(ancestor.pid), ancestor)) parents.set(ancestor.pid, ancestor)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, parent] of pairs) {
      if (!parents.has(parent) || parents.has(pid)) continue
      const ancestor = parents.get(parent)
      if (!sameIdentity(await processIdentity(parent), ancestor)) continue
      const identity = await processIdentity(pid)
      if (identity?.parentPid === parent && sameIdentity(await processIdentity(parent), ancestor)) {
        result.push(identity); parents.set(pid, identity); changed = true
      }
    }
  }
  return result
}

/** Retain observed descendant identities after their parent exits; stopping awaits all polling.
 * @param {object} ancestor The already verified process owned by this invocation.
 * @param {object} operations Descendant discovery operation.
 * @returns {object} Captured descendants and an idempotent asynchronous stop operation.
 */
export function watchOwnedDescendants(ancestor, { scan = descendantsOf } = {}) {
  const known = new Map([[`${ancestor.pid}:${ancestor.started}:${ancestor.path}`, ancestor]])
  const cancellation = new AbortController()
  let failure
  const task = (async () => {
    try {
      while (!cancellation.signal.aborted) {
        for (const child of await scan([...known.values()])) known.set(`${child.pid}:${child.started}:${child.path}`, child)
        try { await delay(100, undefined, { signal: cancellation.signal }) }
        catch (error) { if (error.name !== 'AbortError') throw error }
      }
    } catch (error) { failure = error }
  })()
  return {
    captured: () => [...known.values()].filter(identity => identity !== ancestor),
    stop: async () => { cancellation.abort(); await task; if (failure) throw failure },
  }
}

async function waitUntil(probe, timeoutMs, message, signal) {
  const deadline = performance.now() + timeoutMs
  do { signal?.throwIfAborted(); const value = await probe(); if (value) return value; await delay(250, undefined, { signal }) } while (performance.now() < deadline)
  throw new Error(message)
}

/** Terminate only the still-matching observed process, then wait until it is gone.
 * @param {object} identity Previously observed owned process identity.
 * @param {object} operations Process observation and signaling operations.
 * @returns {Promise<boolean>} Whether this operation sent a termination signal.
 */
export async function reapOwned(identity, { inspect = processIdentity, signal = process.kill.bind(process) } = {}) {
  const same = async () => sameIdentity(await inspect(identity.pid), identity)
  const send = name => {
    try { signal(identity.pid, name); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  if (!await same()) return false
  if (!send('SIGTERM')) return false
  try { await waitUntil(async () => !await same(), 15000, 'Owned process did not terminate') }
  catch {
    if (await same() && !send('SIGKILL')) return true
    await waitUntil(async () => !await same(), 15000, 'Owned process survived cleanup')
  }
  return true
}

/** Execute the runner-only check; preflight never requires or starts a product application.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Verified acceptance evidence or environment preflight observations.
 */
export async function verifyMacosNative(options) {
  assertDisposableRunner(process.env, process.platform)
  const runnerTemp = await realpath(process.env.RUNNER_TEMP)
  const workspace = await realpath(process.env.GITHUB_WORKSPACE)
  const preflight = options.closeMode === 'gui' ? await gui('preflight') : { axTrusted: false, guiAvailable: false }
  if (options.closeMode === 'gui') assert.equal(preflight.guiAvailable, true, 'Runner has no usable GUI session')
  if (options.preflight) return { schemaVersion: 1, platform: 'darwin', closeMode: options.closeMode, preflight: true, ...preflight }
  const app = await realpath(options.app)
  assert.ok(app.endsWith('.app') && (inside(workspace, app) || inside(runnerTemp, app)), 'App must be a CI build inside the workspace or runner temp')
  const prepared = await readFile(join(await realpath(options.preparedRoot), '.bundle-manifest.json'))
  const bundle = JSON.parse(prepared)
  verifyBundle(bundle)
  const appDataRoot = join(homedir(), 'Library/Application Support/DeepSeek Harness')
  for (const path of [appDataRoot, join(homedir(), '.dsh'), '/Applications/ClawMaster.app', join(homedir(), 'Applications/ClawMaster.app')]) {
    assert.equal(await statOrMissing(path), null, 'Refusing an existing desktop installation or Harness home')
  }
  const running = await command('/bin/ps', ['-axo', 'comm='])
  assert.ok(!running.split('\n').some(path => basename(path.trim()) === 'dsh-desktop'), 'Refusing another running desktop')
  const root = await mkdtemp(join(runnerTemp, 'ClawMaster native 验收 # '))
  let ownedAppData = false, desktop, host, exited, verified, primaryFailure
  const trackers = []
  const cancellation = new AbortController()
  const interrupt = () => cancellation.abort(new Error('Native acceptance interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const report = { schemaVersion: 1, platform: 'darwin', closeMode: options.closeMode, runtimeVerified: false, guiCloseVerified: false,
    installedApp: join(root, 'installed/ClawMaster.app'), appDataRoot, preparedManifestSha256: sha256(prepared), launches: [], runs: [] }
  try {
    await mkdir(appDataRoot, { mode: 0o700 })
    ownedAppData = true
    const dshHome = join(root, 'dsh-home')
    await mkdir(join(dshHome, 'sessions'), { recursive: true, mode: 0o700 })
    const settings = join(dshHome, 'settings.yaml'), session = join(dshHome, 'sessions', `.native-acceptance-${randomUUID()}.txt`)
    await writeFile(settings, `# Native acceptance ${randomUUID()}\n{}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(session, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 })
    const settingsHash = sha256(await readFile(settings)), sessionHash = sha256(await readFile(session))
    await writeFile(join(dshHome, 'cordis.patch.yml'), JSON.stringify([{ id: 'clawmaster-notes', config: { vaultRoot: join(root, 'notes') } }]), { flag: 'wx', mode: 0o600 })
    // The persisted enum calls native Node "windows" on every OS; "wsl" is the other environment.
    await writeFile(join(appDataRoot, 'desktop-settings.json'), JSON.stringify({ closeAction: 'exit', agentEnvironment: 'windows' }), { flag: 'wx', mode: 0o600 })
    await mkdir(dirname(report.installedApp), { mode: 0o700 })
    await command('/usr/bin/ditto', [app, report.installedApp], { timeout: 120000 })
    const packagedRoot = join(report.installedApp, 'Contents/Resources/harness-source')
    const packaged = await readFile(join(packagedRoot, '.bundle-manifest.json'))
    assert.ok(packaged.equals(prepared), 'Packaged manifest differs from the prepared release')
    report.packagedManifestSha256 = sha256(packaged)
    const { hashBundledContent } = await import('./bundle-harness-source.mjs')
    report.packagedContentSha256 = hashBundledContent(packagedRoot)
    assert.equal(report.packagedContentSha256, bundle.contentSha256, 'Signed app payload differs from its prepared content')
    const { verifyRpaNative } = await import('./prepare-rpa-native.mjs')
    const helper = verifyRpaNative(packagedRoot, process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
    const capabilities = JSON.parse(await command(helper, ['--native-tool', 'capabilities']))
    assert.ok(Array.isArray(capabilities.capabilities) && capabilities.capabilities.length > 0, 'Packaged native helper cannot report its capabilities')
    report.nativeHelperVerified = true
    const plist = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(report.installedApp, 'Contents/Info.plist')]))
    assert.equal(plist.CFBundleExecutable, 'dsh-desktop')
    assert.equal(plist.CFBundleIdentifier, 'team.nsi.clawmaster.desktop')
    report.installedProductVersion = plist.CFBundleShortVersionString
    assert.equal(report.installedProductVersion, options.version)
    const binary = await realpath(join(report.installedApp, 'Contents/MacOS/dsh-desktop'))
    const runtimePath = join(dshHome, 'desktop/current-runtime.json')
    const readRuntime = async () => JSON.parse(await readFile(runtimePath, 'utf8'))
    for (let attempt = 0; attempt < 2; attempt++) {
      cancellation.signal.throwIfAborted()
      const startedAtUnixMs = Date.now()
      desktop = spawn(binary, [], { cwd: dirname(binary), env: acceptanceEnvironment(process.env, dshHome), stdio: 'ignore' })
      let exitResult = null, spawnError = null
      const launch = { startedAtUnixMs, desktopPid: desktop.pid, observedIdentity: null, spawnFailureCode: null, exit: null }
      report.launches.push(launch)
      exited = new Promise(resolveExit => {
        desktop.once('error', error => { spawnError = error; launch.spawnFailureCode = error.code ?? error.name; resolveExit(null) })
        desktop.once('exit', (code, signal) => { exitResult = { code, signal }; launch.exit = exitResult; resolveExit(exitResult) })
      })
      const desktopIdentity = await processIdentity(desktop.pid)
      launch.observedIdentity = desktopIdentity
      assert.ok(desktopIdentity && desktopIdentity.path === binary, 'Could not establish the copied desktop process identity')
      const tracker = watchOwnedDescendants(desktopIdentity)
      trackers.push(tracker)
      const ready = await waitUntil(async () => {
        assert.equal(spawnError, null, 'Desktop failed to spawn')
        assert.equal(exitResult, null, 'Desktop exited before readiness')
        if (!await statOrMissing(runtimePath)) return false
        const runtime = await readRuntime()
        if (runtime.status !== 'ready' || runtime.desktopPid !== desktop.pid || runtime.observedAtUnixMs < startedAtUnixMs) return false
        const observedHost = await processIdentity(runtime.hostPid)
        assert.ok(observedHost && observedHost.parentPid === desktop.pid, 'Runtime Host is not a child of this desktop')
        host = observedHost
        const window = options.closeMode === 'gui' ? (await gui('observe', desktop.pid)).window : null
        if (options.closeMode === 'gui' && (!window || !window.visible)) return false
        return { runtime, window }
      }, options.timeoutMs, 'Timed out waiting for the owned desktop and ready runtime', cancellation.signal)
      const identity = await processIdentity(desktop.pid)
      assert.ok(identity && identity.path === binary, 'Observed desktop executable differs from the copied app')
      assert.ok(inside(appDataRoot, ready.runtime.harnessRoot), 'Runtime root is outside the owned data directory')
      const response = await fetch(`http://127.0.0.1:${ready.runtime.port}/`, { signal: AbortSignal.timeout(10000), redirect: 'error' })
      await response.body?.cancel()
      const record = { ...ready, desktopPid: desktop.pid, hostPid: host.pid, hostParentPid: host.parentPid,
        desktopPath: binary, startedAtUnixMs, desktopAlive: true, hostAlive: true, httpStatus: response.status,
        runtimeManifestSha256: sha256(await readFile(join(ready.runtime.harnessRoot, '.bundle-manifest.json'))) }
      report.runs.push(record)
      if (options.closeMode === 'gui') {
        record.closeMethod = 'AXCloseButton'
        record.closeRequested = (await gui('close', desktop.pid)).closeRequested === true
      } else { record.closeMethod = 'SIGTERM'; desktop.kill('SIGTERM') }
      await waitUntil(() => exitResult, 45000, 'Desktop did not exit after the requested close', cancellation.signal)
      record.desktopExit = await exited
      record.desktopExited = true
      record.hostTerminatedByAcceptance = false
      if (options.closeMode === 'terminate') record.hostTerminatedByAcceptance = await reapOwned(host)
      await waitUntil(async () => !await processIdentity(host.pid), 15000, 'Owned Host survived desktop closing', cancellation.signal)
      record.hostExited = true
      record.stopped = await readRuntime()
      record.settingsMarkerPreserved = sha256(await readFile(settings)) === settingsHash
      record.sessionMarkerPreserved = sha256(await readFile(session)) === sessionHash
      await tracker.stop()
      desktop = undefined; host = undefined; exited = undefined
    }
    verified = verifyMacosNativeEvidence(report, bundle, options.version)
  } catch (error) {
    primaryFailure = error
    report.failure = error.message
    report.retainedPaths = [root, ...(ownedAppData ? [appDataRoot] : [])]
    report.cleanupComplete = false
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    throw error
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    const cleanupErrors = []
    const clean = async operation => { try { await operation() } catch (error) { cleanupErrors.push(error) } }
    await clean(async () => { if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
      desktop.kill('SIGTERM')
      try { await waitUntil(() => desktop.exitCode !== null || desktop.signalCode !== null, 15000, 'Owned desktop did not terminate') }
      catch { desktop.kill('SIGKILL'); await waitUntil(() => desktop.exitCode !== null || desktop.signalCode !== null, 15000, 'Owned desktop survived cleanup') }
    } })
    // Await every tracker even after failure; captured descendants can now be reparented or orphaned.
    for (const tracker of trackers) await clean(() => tracker.stop())
    if (exited && (desktop?.exitCode !== null || desktop?.signalCode !== null)) await clean(() => exited)
    if (host) await clean(() => reapOwned(host))
    for (const tracker of trackers) for (const child of tracker.captured()) await clean(async () => {
      const terminated = await reapOwned(child)
      if (terminated && !primaryFailure && options.closeMode === 'gui') {
        throw new Error('An owned descendant survived normal application closing')
      }
    })
    // A failed launch can exit between observations; retain its files even when every known PID is gone.
    if (!primaryFailure && cleanupErrors.length === 0) {
      if (ownedAppData) await clean(() => rm(appDataRoot, { recursive: true, force: true }))
      await clean(() => rm(root, { recursive: true, force: true }))
    }
    if (cleanupErrors.length > 0) {
      report.cleanupComplete = false
      report.retainedPaths = [root, ...(ownedAppData ? [appDataRoot] : [])]
      report.cleanupFailures = cleanupErrors.map(error => error.message)
      await mkdir(dirname(options.output), { recursive: true })
      await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], 'Native acceptance cleanup failed; original failure and cleanup failures are retained in the report')
    }
  }
  await mkdir(dirname(options.output), { recursive: true })
  await writeFile(options.output, `${JSON.stringify(verified, null, 2)}\n`, { mode: 0o600 })
  return verified
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const evidence = await verifyMacosNative(parseOptions(process.argv.slice(2)))
    console.log(JSON.stringify({ preflight: evidence.preflight ?? false, runtimeVerified: evidence.runtimeVerified ?? false,
      guiCloseVerified: evidence.guiCloseVerified ?? false, closeMode: evidence.closeMode, axTrusted: evidence.axTrusted }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
