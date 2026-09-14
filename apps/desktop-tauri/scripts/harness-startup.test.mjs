import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import test from 'node:test'

const STARTUP_TIMEOUT_MS = 60000
const REQUEST_TIMEOUT_MS = 10000
const SHUTDOWN_TIMEOUT_MS = 5000

/** Keep startup diagnostics useful without exposing launch URLs or inherited credentials. */
function redact(text) {
  let safe = text.replace(/([?&](?:token|key|secret|password)=)[^\s&"'<>]+/gi, '$1[redacted]')
    .replace(/((?:authorization|token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'<>]+/gi, '$1[redacted]')
    .replace(/(dsh-auth-[\w-]+=)[^;\s"']+/g, '$1[redacted]')
  for (const [name, value] of Object.entries(process.env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(name) && value && value.length >= 8) {
      safe = safe.replaceAll(value, '[redacted]')
    }
  }
  return safe
}

/** Observe readiness and pipe closure before the child can emit either event. */
function observeHost(child) {
  const lines = []
  let resolveReady
  let closed = false
  const ready = new Promise(done => { resolveReady = done })
  const append = (stream, line) => {
    lines.push(`${stream}: ${redact(line).slice(-2000)}`)
    if (lines.length > 40) lines.shift()
  }
  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  stdout.on('line', line => {
    append('stdout', line)
    const match = line.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
    if (match) resolveReady(match[1])
  })
  stderr.on('line', line => append('stderr', line))
  child.once('error', error => append('spawn', String(error)))
  const done = new Promise(resolveDone => child.once('close', (code, signal) => {
    closed = true
    stdout.close()
    stderr.close()
    resolveDone({ code, signal })
  }))
  return {
    child,
    done,
    isClosed: () => closed,
    diagnostics: () => lines.join('\n') || '(Host 未输出诊断)',
    startup: Promise.race([
      ready,
      done.then(({ code, signal }) => {
        throw new Error(`Host 提前退出：code=${code}, signal=${signal}`)
      }),
    ]),
  }
}

/** Bound an observation and release its timer and cancellation listener on every outcome. */
async function withDeadline(promise, milliseconds, message, signal) {
  let timer
  let abort
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
        abort = () => reject(new Error('启动验收已取消'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

/** Terminate only the test-owned process tree and wait until its inherited pipes close. */
async function stopHost(host, graceTimeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (host.isClosed()) return { forced: false }
  const pid = host.child.pid
  if (pid === undefined) {
    await withDeadline(host.done, SHUTDOWN_TIMEOUT_MS, 'Host 未成功创建，等待关闭超时')
    return { forced: false }
  }
  const signalGroup = signal => {
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: SHUTDOWN_TIMEOUT_MS,
    })
    if (result.error) throw result.error
    await withDeadline(host.done, SHUTDOWN_TIMEOUT_MS, 'taskkill 后 Host 进程树未关闭')
    return { forced: true }
  }
  signalGroup('SIGTERM')
  const graceful = await withDeadline(host.done.then(() => true), graceTimeoutMs, 'Host SIGTERM 超时')
    .catch(error => {
      if (error.message !== 'Host SIGTERM 超时') throw error
      return false
    })
  if (graceful) return { forced: false }
  signalGroup('SIGKILL')
  await withDeadline(host.done, SHUTDOWN_TIMEOUT_MS, 'SIGKILL 后 Host 进程树未关闭')
  return { forced: true }
}

// 使用安装过生产依赖的裁剪包，验证全新主目录不会借用用户已有的 profile。
test('裁剪包在全新主目录加载默认插件，企业数据与笔记通过认证并跨 Host 重启持久化', {
  timeout: 2 * STARTUP_TIMEOUT_MS + 40 * REQUEST_TIMEOUT_MS + 4 * SHUTDOWN_TIMEOUT_MS + 10000,
}, async context => {
  const root = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT
    ?? fileURLToPath(new URL('../bundled/harness', import.meta.url)))
  const prefix = join(tmpdir(), 'dsh-desktop-startup-')
  const home = await mkdtemp(prefix)
  let host
  let previousPort
  try {
    const patch = join(home, 'smoke.patch.yml')
    const notesRoot = join(await realpath(home), 'notes-vault')
    // Notes defaults to the real Documents folder, independently of DSH_HOME.
    await writeFile(patch, `${JSON.stringify([{ id: 'clawmaster-notes', config: { vaultRoot: notesRoot } }])}\n`)
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(name)))
    const request = (url, options) => fetch(url, {
      ...options, signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    const start = async () => {
      const child = spawn(process.execPath, ['--import', join(root, 'desktop-defaults.mjs'),
        join(root, 'apps/cli/lib/bin.js'), 'web',
        '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
        cwd: root, env: { ...environment, DSH_HOME: home, DSH_DESKTOP_DEFAULTS: '1', NODE_ENV: 'production' },
        detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      host = observeHost(child)
      const startup = await withDeadline(host.startup, STARTUP_TIMEOUT_MS, 'Host 启动超时', context.signal)
      const base = new URL('/', startup).href
      assert.equal((await request(base)).status, 401)
      const exchange = await request(startup, { redirect: 'manual' })
      assert.equal(exchange.status, 303)
      assert.equal(exchange.headers.get('location'), '/')
      const cookie = exchange.headers.get('set-cookie')
      assert.match(cookie, /HttpOnly; SameSite=Strict/)
      return { base, cookie: cookie.split(';')[0] }
    }
    const first = await start()
    const page = await request(first.base, { headers: { cookie: first.cookie } })
    assert.equal(page.status, 200)
    const html = await page.text()
    const title = html.match(/<title>(.*?)<\/title>/)?.[1]
    assert.equal(title, 'ClawMaster')
    const serializedGraph = html.match(/<script>globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)?.[1]
    assert.ok(serializedGraph, '首页必须提供客户端启动图')
    const graph = JSON.parse(serializedGraph)
    const entries = new Set(graph.entries.map(entry => entry.id))
    for (const name of ['@xmanrui/dsh-im', 'dsh-better-sidebar', '@clawmaster/dsh-frontend', '@clawmaster/dsh-notes', '@clawmaster/dsh-office']) {
      assert.ok(entries.has(name), `全新主目录缺少默认客户端插件：${name}`)
    }
    const snapshotPath = '/api/clawmaster/enterprise'
    const commandPath = '/api/clawmaster/enterprise/command'
    const restorePath = '/api/clawmaster/enterprise/restore'
    const backupPath = '/api/clawmaster/enterprise/backup'
    const workspacePath = '/api/clawmaster/workspace'
    const notesTreePath = '/api/clawmaster/notes/tree'
    const notesCommandPath = '/api/clawmaster/notes/command'
    const noteId = '验收/冷启动 #1.md'
    const noteText = '# 冷启动验收\n\n仅临时笔记库。\n'
    const editedNoteText = `${noteText}\n已保存的修改。\n`
    const createNote = { request: { action: 'create', id: noteId, text: noteText } }
    const noteUrl = base => {
      const url = new URL('/api/clawmaster/notes/note', base)
      url.searchParams.set('id', noteId)
      return url
    }
    const managedRoot = join(await realpath(home), 'watchdog-workspaces')
    const contact = {
      id: 'smoke-contact', name: '验收联系人', company: '验收企业', stage: 'lead',
      nextAction: '确认需求', nextActionDate: null,
    }
    const command = { generation: 0, revision: 0, commandId: 'smoke-command', command: { type: 'contact.upsert', contact } }
    const post = (base, path, value, headers = {}) => request(new URL(path, base), {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
    })
    assert.equal((await request(new URL(snapshotPath, first.base))).status, 401)
    assert.equal((await post(first.base, commandPath, command)).status, 401)
    assert.equal((await post(first.base, restorePath, {})).status, 401)
    assert.equal((await request(new URL(backupPath, first.base))).status, 401)
    assert.equal((await post(first.base, workspacePath, { kind: 'task' })).status, 401)
    assert.equal((await request(new URL(notesTreePath, first.base))).status, 401)
    assert.equal((await request(noteUrl(first.base))).status, 401)
    assert.equal((await post(first.base, notesCommandPath, createNote)).status, 401)
    const authenticated = { cookie: first.cookie, origin: new URL(first.base).origin }
    const notesEntry = graph.entries.find(entry => entry.id === '@clawmaster/dsh-notes')
    const notesScriptUrl = new URL(notesEntry.url, first.base)
    assert.equal(notesScriptUrl.origin, new URL(first.base).origin)
    const notesScript = await request(notesScriptUrl, { headers: authenticated })
    assert.equal(notesScript.status, 200)
    assert.match(notesScript.headers.get('content-type'), /javascript/)
    assert.match(await notesScript.text(), /window\.__ModuleLoader__\.load\(\{ id: "@clawmaster\/dsh-notes"/)
    const officeUrl = new URL('/clawmaster/office/runtime/index.html', first.base)
    assert.equal((await request(officeUrl)).status, 401)
    const office = await request(officeUrl, { headers: authenticated })
    assert.equal(office.status, 200)
    assert.match(office.headers.get('content-security-policy'), /connect-src 'self'/)
    assert.match(await office.text(), /frame\.js/)
    const crossOrigin = { cookie: first.cookie, origin: 'https://cross-origin.invalid' }
    for (const [path, value] of [[commandPath, command], [workspacePath, { kind: 'task' }], [notesCommandPath, createNote]]) {
      const denied = await post(first.base, path, value, crossOrigin)
      assert.equal(denied.status, 403)
      assert.equal(await denied.text(), 'forbidden')
    }
    const notesTree = await request(new URL(notesTreePath, first.base), { headers: authenticated })
    assert.equal(notesTree.status, 200)
    assert.equal(notesTree.headers.get('cache-control'), 'no-store')
    const initialNotes = await notesTree.json()
    assert.equal(initialNotes.vault, notesRoot)
    assert.deepEqual(initialNotes.notes.map(note => note.id), ['欢迎.md'])
    const createdNote = await post(first.base, notesCommandPath, createNote, authenticated)
    assert.equal(createdNote.status, 200)
    const creation = await createdNote.json()
    assert.match(creation.revision, /^sha256-[0-9a-f]{64}$/)
    assert.deepEqual(creation, { action: 'create', id: noteId, revision: creation.revision, previousRevision: null })
    const loadedNote = await request(noteUrl(first.base), { headers: authenticated })
    assert.equal(loadedNote.status, 200)
    const originalNote = await loadedNote.json()
    assert.equal(originalNote.id, noteId)
    assert.equal(originalNote.text, noteText)
    assert.equal(originalNote.revision, creation.revision)
    const saveNote = { request: { action: 'save', id: noteId, text: editedNoteText, expectedRevision: creation.revision } }
    const savedNote = await post(first.base, notesCommandPath, saveNote, authenticated)
    assert.equal(savedNote.status, 200)
    const noteChange = await savedNote.json()
    assert.match(noteChange.revision, /^sha256-[0-9a-f]{64}$/)
    assert.notEqual(noteChange.revision, creation.revision)
    assert.deepEqual(noteChange, { action: 'save', id: noteId, revision: noteChange.revision, previousRevision: creation.revision })
    const staleNote = await post(first.base, notesCommandPath, {
      request: { ...saveNote.request, text: '过期修改不得覆盖已保存内容。' },
    }, authenticated)
    assert.equal(staleNote.status, 409)
    const conflict = await staleNote.json()
    assert.equal(conflict.error.code, 'conflict')
    assert.equal(conflict.error.currentRevision, noteChange.revision)
    assert.equal(await readFile(join(notesRoot, noteId), 'utf8'), editedNoteText)
    const initial = await request(new URL(snapshotPath, first.base), { headers: authenticated })
    assert.equal(initial.status, 200)
    assert.equal(initial.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await initial.json(), { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] })
    assert.equal((await post(first.base, workspacePath, { kind: 'invalid' }, authenticated)).status, 400)
    assert.equal((await stat(join(managedRoot, 'im'))).isDirectory(), true)
    for (const kind of ['tasks', 'desk']) await assert.rejects(stat(join(managedRoot, kind)), { code: 'ENOENT' })
    const allocate = async (kind, connection) => {
      const response = await post(connection.base, workspacePath, { kind }, {
        cookie: connection.cookie, origin: new URL(connection.base).origin,
      })
      assert.equal(response.status, 200)
      const workspace = await response.json()
      assert.equal(typeof workspace.workspaceId, 'string')
      assert.notEqual(workspace.workspaceId, '')
      assert.equal((await stat(workspace.path)).isDirectory(), true)
      return workspace
    }
    const task = await allocate('task', first)
    assert.equal(resolve(task.path, '..'), join(managedRoot, 'tasks'))
    const desk = await allocate('tools', first)
    assert.equal(desk.path, join(managedRoot, 'desk'))
    const saved = await post(first.base, commandPath, command, authenticated)
    assert.equal(saved.status, 200)
    let expected = await saved.json()
    assert.equal(expected.revision, 1)
    assert.deepEqual(expected.contacts, [{ ...contact, updatedAt: expected.contacts[0]?.updatedAt }])
    assert.ok(Number.isFinite(Date.parse(expected.contacts[0].updatedAt)))
    assert.equal(expected.audit.length, 1)
    assert.equal(expected.audit[0].commandId, command.commandId)
    const backupResponse = await request(new URL(backupPath, first.base), { headers: authenticated })
    assert.equal(backupResponse.status, 200)
    const backup = await backupResponse.json()
    const confirmation = { confirm: true, expectedGeneration: 0, expectedRevision: 1, backup }
    assert.equal((await post(first.base, restorePath, confirmation, { ...authenticated, origin: 'https://foreign.invalid' })).status, 403)
    const restoreResponse = await post(first.base, restorePath, confirmation, authenticated)
    assert.equal(restoreResponse.status, 200)
    expected = { ...expected, generation: 1 }
    assert.deepEqual(await restoreResponse.json(), expected)
    assert.equal((await post(first.base, commandPath, command, authenticated)).status, 409)
    assert.equal((await post(first.base, restorePath, confirmation, authenticated)).status, 409)
    assert.equal(host.child.signalCode, null)
    assert.equal(host.child.exitCode, null)
    await stopHost(host)
    assert.equal(host.isClosed(), true)
    // Hold the former port so the replacement Host's listen(0) must choose a new origin.
    previousPort = createServer(socket => socket.destroy())
    await withDeadline(new Promise((done, reject) => {
      previousPort.once('error', reject)
      previousPort.listen(Number(new URL(first.base).port), '127.0.0.1', done)
    }), REQUEST_TIMEOUT_MS, '旧端口保留超时', context.signal)
    const second = await start()
    assert.notEqual(new URL(second.base).port, new URL(first.base).port)
    const restored = await request(new URL(snapshotPath, second.base), { headers: { cookie: second.cookie } })
    assert.equal(restored.status, 200)
    assert.deepEqual(await restored.json(), expected)
    assert.deepEqual(await allocate('tools', second), desk)
    const secondAuthenticated = { cookie: second.cookie, origin: new URL(second.base).origin }
    const restoredNote = await request(noteUrl(second.base), { headers: secondAuthenticated })
    assert.equal(restoredNote.status, 200)
    const persistedNote = await restoredNote.json()
    assert.equal(persistedNote.text, editedNoteText)
    assert.equal(persistedNote.revision, noteChange.revision)
    const deletedNote = await post(second.base, notesCommandPath, {
      request: { action: 'delete', id: noteId },
    }, secondAuthenticated)
    assert.equal(deletedNote.status, 200)
    assert.deepEqual(await deletedNote.json(), {
      action: 'delete', id: noteId, revision: null, previousRevision: noteChange.revision,
    })
    assert.equal((await request(noteUrl(second.base), { headers: secondAuthenticated })).status, 404)
    await assert.rejects(stat(join(notesRoot, noteId)), { code: 'ENOENT' })
    const remainingNotes = await request(new URL(notesTreePath, second.base), { headers: secondAuthenticated })
    assert.equal(remainingNotes.status, 200)
    assert.deepEqual((await remainingNotes.json()).notes.map(note => note.id), ['欢迎.md'])
    assert.equal(host.child.signalCode, null)
    assert.equal(host.child.exitCode, null)
  } catch (error) {
    throw new Error(`${redact(String(error))}\n${host?.diagnostics() ?? '(Host 尚未启动)'}`)
  } finally {
    if (previousPort) await withDeadline(new Promise((done, reject) => previousPort.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else done()
    })), SHUTDOWN_TIMEOUT_MS, '旧端口保留未关闭')
    if (host) await stopHost(host)
    assert.ok(home.startsWith(prefix))
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('启动失败保留双流诊断并隐藏跨数据块输出的令牌', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('loading profile\\n')
    process.stderr.write('connection failed: http://127.0.0.1:1234/?tok')
    process.stderr.end('en=fixture-private-token\\ndsh-auth-fixture=fixture-private-cookie; HttpOnly\\n')
    process.exitCode = 7
  `], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const host = observeHost(child)
  try {
    await assert.rejects(withDeadline(host.startup, 5000, 'fixture startup timeout'), /code=7, signal=null/)
    assert.match(host.diagnostics(), /stdout: loading profile/)
    assert.match(host.diagnostics(), /stderr: connection failed/)
    assert.match(host.diagnostics(), /token=\[redacted\]/)
    assert.doesNotMatch(host.diagnostics(), /fixture-private-token/)
    assert.doesNotMatch(host.diagnostics(), /fixture-private-cookie/)
    assert.equal(host.isClosed(), true)
  } finally {
    await stopHost(host)
  }
})

test('拒绝 SIGTERM 的测试进程在期限内被回收', {
  timeout: 10000,
  skip: process.platform === 'win32' ? 'Windows 使用 taskkill，不支持 POSIX 进程组信号' : false,
}, async () => {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    process.stdout.write('dsh web: http://127.0.0.1:1234/?token=fixture-token\\n')
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const host = observeHost(child)
  try {
    await withDeadline(host.startup, 5000, 'fixture startup timeout')
    assert.deepEqual(await stopHost(host, 100), { forced: true })
    assert.deepEqual(await host.done, { code: null, signal: 'SIGKILL' })
    assert.equal(host.isClosed(), true)
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' })
  } finally {
    await stopHost(host)
  }
})
