/** Exercise CI keyring isolation with synthetic commands; never contact a real D-Bus or keyring. */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { load } from 'js-yaml'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./with-linux-keyring.sh', import.meta.url))
const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0
const posix = process.platform !== 'win32' && bashAvailable

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-keyring-'))
  const bin = join(root, 'bin'), runnerTemp = join(root, 'runner-temp')
  mkdirSync(bin); mkdirSync(runnerTemp)
  const helper = join(bin, 'gnome-keyring-daemon')
  t.after(async () => {
    const pidFile = join(root, 'daemon-pid')
    if (existsSync(pidFile)) {
      const { pid, ppid } = JSON.parse(readFileSync(pidFile, 'utf8'))
      const observe = () => {
        try {
          return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'command='], {
            encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim()
        } catch (error) {
          if (error.status === 1 || error.code === 'ESRCH') return null
          throw error
        }
      }
      const identity = observe()
      if (identity !== null) {
        assert.equal(Number(identity.split(/\s+/, 1)[0]), ppid, `Daemon parent changed; files retained at ${root}`)
        assert.ok(identity.includes(helper), `Daemon identity changed; files retained at ${root}`)
        try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        const deadline = performance.now() + 2000
        while (observe() !== null) {
          assert.ok(performance.now() < deadline, `Daemon did not exit; files retained at ${root}`)
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })
  const writeCommand = (name, content) => { const path = join(bin, name); writeFileSync(path, content); chmodSync(path, 0o700) }
  writeCommand('uname', '#!/bin/sh\nprintf "Linux\\n"\n')
  writeCommand('gnome-keyring-daemon', `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.readFileSync(0);
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.TEST_DAEMON_TERM, 'received');
  if (process.env.TEST_IGNORE_TERM !== '1') process.exit(0);
});
fs.writeFileSync(process.env.TEST_DAEMON_PID, JSON.stringify({pid:process.pid,ppid:process.ppid}));
fs.writeFileSync(path.join(process.env.XDG_RUNTIME_DIR, 'fake-service.pid'), String(process.pid));
setInterval(() => {}, 1000);
`)
  writeCommand('gdbus', `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const pidFile = path.join(process.env.XDG_RUNTIME_DIR, 'fake-service.pid');
(async () => {
  if (process.argv[2] === 'wait') {
    for (let i = 0; i < 500; i++) {
      if (fs.existsSync(pidFile)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Synthetic daemon did not become ready');
  }
  const pid = Number(fs.readFileSync(pidFile, 'utf8')) + (process.env.TEST_FOREIGN_OWNER === '1' ? 1 : 0);
  process.stdout.write('(uint32 ' + pid + ',)\\n');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`)
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    RUNNER_TEMP: runnerTemp, DBUS_SESSION_BUS_ADDRESS: 'synthetic-no-real-bus',
    GNOME_KEYRING_CONTROL: 'inherited-control-must-be-cleared', GNOME_KEYRING_PID: 'inherited-pid-must-be-cleared',
    TEST_DAEMON_PID: join(root, 'daemon-pid'), TEST_DAEMON_TERM: join(root, 'daemon-term'),
  }
  return { root, runnerTemp, env }
}

test('the keyring wrapper has valid Bash syntax', { skip: !bashAvailable }, () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('local or incomplete runner requests fail before creating state or running a command', { skip: !posix }, t => {
  const { runnerTemp, env } = fixture(t)
  for (const override of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'macOS' }, { RUNNER_TEMP: 'relative' }, { DBUS_SESSION_BUS_ADDRESS: '' }]) {
    const result = spawnSync('bash', [script, process.execPath, '-e', 'console.log("unexpected command")'], {
      encoding: 'utf8', timeout: 5000, env: { ...env, ...override },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /requires a hosted Linux runner/)
    assert.equal(result.stdout, '')
    assert.deepEqual(readdirSync(runnerTemp), [])
  }
})

test('synthetic Secret Service ownership gates the command and private XDG state is removed after success', { skip: !posix }, async t => {
  const { runnerTemp, env } = fixture(t)
  const { stdout } = await execute('bash', [script, process.execPath, '-e',
    'console.log(JSON.stringify({home:process.env.HOME,data:process.env.XDG_DATA_HOME,control:process.env.GNOME_KEYRING_CONTROL??null,pid:process.env.GNOME_KEYRING_PID??null}))'],
  { env, timeout: 20000 })
  const observed = JSON.parse(stdout)
  assert.equal(observed.home, env.HOME)
  assert.ok(observed.data.startsWith(`${runnerTemp}/clawmaster-keyring-`))
  assert.equal(observed.control, null)
  assert.equal(observed.pid, null)
  assert.equal(readFileSync(env.TEST_DAEMON_TERM, 'utf8'), 'received')
  assert.deepEqual(readdirSync(runnerTemp), [])
})

test('a different D-Bus owner prevents the command and retains failure diagnostics', { skip: !posix }, async t => {
  const { runnerTemp, env } = fixture(t)
  await assert.rejects(execute('bash', [script, process.execPath, '-e', 'console.log("unexpected command")'], {
    env: { ...env, TEST_FOREIGN_OWNER: '1' }, timeout: 20000,
  }), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.match(error.stderr, /not owned by this acceptance command/)
    assert.match(error.stderr, /files retained at/)
    return true
  })
  assert.equal(readdirSync(runnerTemp).length, 1)
})

test('a synthetic daemon that ignores TERM is killed without hanging cleanup', { skip: !posix }, async t => {
  const { runnerTemp, env } = fixture(t)
  await execute('bash', [script, process.execPath, '-e', 'process.exit(0)'], {
    env: { ...env, TEST_IGNORE_TERM: '1' }, timeout: 30000,
  })
  assert.equal(readFileSync(env.TEST_DAEMON_TERM, 'utf8'), 'received')
  assert.deepEqual(readdirSync(runnerTemp), [])
})

test('the Linux bridge workflow owns a fresh D-Bus session and installs its real Secret Service', () => {
  const workflow = load(readFileSync(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.build.steps
  const dependencies = steps.find(step => step.name === 'Install Linux bundle dependencies')
  for (const packageName of ['gnome-keyring', 'libglib2.0-bin', 'dbus']) assert.ok(dependencies.run.includes(packageName))
  const bridge = steps.find(step => step.name === 'Verify RPA control plane and distributed native bridge')
  assert.equal(bridge.env.CLAWMASTER_REQUIRE_NATIVE, '1')
  assert.equal(bridge.shell, 'pwsh')
  assert.ok(bridge.run.includes("if ($env:RUNNER_OS -eq 'Linux')"))
  assert.match(bridge.run, /dbus-run-session -- bash apps\/desktop-tauri\/scripts\/with-linux-keyring\.sh npm test --prefix frontends\/rpa/)
  assert.ok(bridge.run.includes("if ($LASTEXITCODE -ne 0) { throw 'Native RPA bridge acceptance failed' }"))
})
