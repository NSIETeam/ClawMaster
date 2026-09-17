import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import KeychainCredentialProvider, { referenceInfo, removeDotEnvAssignments } from '../dist/index.js'
import { createCredentialBroker } from '../src/native-transport.ts'

const require = createRequire(import.meta.url)

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-keychain-'))
  try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('credentials broker uses the dedicated prefix and request/reply protocol', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString('utf8') })
  const broker = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => 'request-1' })
  stdin.write('{"protocol":"clawmaster-credentials/1","type":"ready","supported":true}\n')
  const pending = broker.set('ref:DEEPSEEK_API_KEY', 'secret-value')
  await new Promise(resolve => setImmediate(resolve))
  const request = output.split('\n').filter(line => line.startsWith('\x1eCLAWMASTER_CREDENTIALS_V1:'))
    .map(line => JSON.parse(line.slice('\x1eCLAWMASTER_CREDENTIALS_V1:'.length)))
    .find(frame => frame.type === 'set')
  assert.deepEqual(request, {
    protocol: 'clawmaster-credentials/1', type: 'set', requestId: 'request-1',
    reference: 'ref:DEEPSEEK_API_KEY', value: 'secret-value',
  })
  stdin.write(`${JSON.stringify({ protocol: 'clawmaster-credentials/1', type: 'result', requestId: 'request-1', ok: true })}\n`)
  await pending
  broker.close()
  stdin.destroy()
  stdout.destroy()
})

test('a recreated broker resumes paused stdin before completing its hello handshake', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdin.pause()
  stdout.on('data', chunk => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.startsWith('\x1eCLAWMASTER_CREDENTIALS_V1:')) continue
      const frame = JSON.parse(line.slice('\x1eCLAWMASTER_CREDENTIALS_V1:'.length))
      if (frame.type === 'hello') stdin.write('{"protocol":"clawmaster-credentials/1","type":"ready","supported":true}\n')
      if (frame.type === 'get') stdin.write(`${JSON.stringify({ protocol: 'clawmaster-credentials/1', type: 'result', requestId: frame.requestId, ok: true, value: 'stored' })}\n`)
    }
  })
  const first = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => 'first' })
  assert.equal(await first.get('ref:DEEPSEEK_API_KEY'), 'stored')
  first.close()
  stdin.pause()
  const second = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => 'second' })
  assert.equal(stdin.readableFlowing, true)
  assert.equal(await second.get('ref:DEEPSEEK_API_KEY'), 'stored')
  second.close()
  stdin.destroy()
  stdout.destroy()
})

test('the first credential request waits for a delayed native ready reply', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    const frame = JSON.parse(chunk.toString('utf8').slice('\x1eCLAWMASTER_CREDENTIALS_V1:'.length))
    if (frame.type === 'hello') setImmediate(() => stdin.write('{"protocol":"clawmaster-credentials/1","type":"ready","supported":true}\n'))
    if (frame.type === 'get') stdin.write(`${JSON.stringify({ protocol: 'clawmaster-credentials/1', type: 'result', requestId: frame.requestId, ok: true, value: 'stored' })}\n`)
  })
  const broker = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => 'delayed-ready' })
  assert.equal(await broker.get('ref:DEEPSEEK_API_KEY'), 'stored')
  broker.close()
  stdin.destroy()
  stdout.destroy()
})

test('credentials broker reports the native error class without including secret data', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    const line = chunk.toString('utf8').slice('\x1eCLAWMASTER_CREDENTIALS_V1:'.length)
    const request = JSON.parse(line)
    if (request.type === 'hello') {
      stdin.write('{"protocol":"clawmaster-credentials/1","type":"ready","supported":true}\n')
      return
    }
    stdin.write(`${JSON.stringify({ protocol: 'clawmaster-credentials/1', type: 'result', requestId: request.requestId, ok: false, error: 'access-denied' })}\n`)
  })
  const broker = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => 'request-2' })
  await assert.rejects(broker.set('ref:DEEPSEEK_API_KEY', 'secret-value'), error => {
    assert.match(error.message, /access-denied/u)
    assert.doesNotMatch(error.message, /secret-value/u)
    return true
  })
  broker.close()
  stdin.destroy()
  stdout.destroy()
})

test('credential migration uses the native no-clobber operation and checks its response', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const requests = []
  stdout.on('data', chunk => {
    const request = JSON.parse(chunk.toString('utf8').slice('\x1eCLAWMASTER_CREDENTIALS_V1:'.length))
    if (request.type === 'hello') {
      stdin.write('{"protocol":"clawmaster-credentials/1","type":"ready","supported":true}\n')
      return
    }
    requests.push(request)
    stdin.write(`${JSON.stringify({ protocol: 'clawmaster-credentials/1', type: 'result', requestId: request.requestId, ok: true, inserted: false })}\n`)
  })
  const broker = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => `request-${requests.length + 1}` })
  assert.equal(await broker.setIfAbsent('ref:DEEPSEEK_API_KEY', 'secret-value'), false)
  assert.equal(requests[0]?.type, 'set-if-absent')
  broker.close()
  stdin.destroy()
  stdout.destroy()
})

test('oversized frames from another host protocol do not close the credential channel', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const broker = createCredentialBroker({ stdin, stdout, timeoutMs: 1000, createRequestId: () => 'after-large-frame' })
  stdin.write('{"protocol":"clawmaster-credentials/1","type":"ready","supported":true}\n')
  const unrelated = Buffer.from(`${JSON.stringify({ protocol: 'clawmaster-rpa/1', type: 'snapshot', payload: 'x'.repeat(160 * 1024) })}\n`)
  for (let offset = 0; offset < unrelated.length; offset += 64 * 1024) {
    stdin.write(unrelated.subarray(offset, offset + 64 * 1024))
  }
  const pending = broker.set('ref:DEEPSEEK_API_KEY', 'secret-value')
  let request = ''
  stdout.on('data', chunk => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.startsWith('\x1eCLAWMASTER_CREDENTIALS_V1:')) continue
      const frame = JSON.parse(line.slice('\x1eCLAWMASTER_CREDENTIALS_V1:'.length))
      if (frame.type === 'set') request = frame.requestId
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  stdin.write(`${JSON.stringify({ protocol: 'clawmaster-credentials/1', type: 'result', requestId: 'after-large-frame', ok: true })}\n`)
  await pending
  assert.equal(request, 'after-large-frame')
  broker.close()
  stdin.destroy()
  stdout.destroy()
})

test('dotenv cleanup removes only selected assignments and preserves untouched bytes', () => {
  const source = '# keep\r\nDEEPSEEK_API_KEY="line one\nline two"\r\nOTHER=value  \r\nexport SERVICE_TOKEN=token\n'
  assert.equal(removeDotEnvAssignments(source, ['DEEPSEEK_API_KEY']), '# keep\r\nOTHER=value  \r\nexport SERVICE_TOKEN=token\n')
  assert.equal(removeDotEnvAssignments(source, ['DEEPSEEK_API_KEY', 'SERVICE_TOKEN']), '# keep\r\nOTHER=value  \r\n')
})

test('malformed dotenv remains unchanged when a safe assignment removal cannot be proved', () => {
  const source = 'DEEPSEEK_API_KEY="unfinished\nOTHER=value\n'
  assert.equal(removeDotEnvAssignments(source, ['DEEPSEEK_API_KEY']), undefined)
})

test('an absent credential has no source while a stored credential identifies the secure store', () => {
  assert.deepEqual(referenceInfo(false), { configured: false, writable: true })
  assert.deepEqual(referenceInfo(true), { configured: true, source: 'os-secure-store', writable: true })
})

test('unavailable OS storage does not prevent the provider or DSH context from starting', async () => {
  await withDirectory(async directory => {
    const legacy = join(directory, '.credentials.yaml')
    await writeFile(legacy, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: legacy-secret\n', { mode: 0o600 })
    const ctx = new Context()
    const fiber = ctx.plugin(KeychainCredentialProvider, { dshHome: directory })
    await fiber
    assert.ok(ctx.credentials)
    assert.match(await readFile(legacy, 'utf8'), /DEEPSEEK_API_KEY/u)
    await fiber.dispose()
  })
})

test('unavailable OS storage leaves dotenv credentials intact when the legacy YAML is absent', async () => {
  await withDirectory(async directory => {
    const previous = process.cwd()
    const envFile = join(directory, '.env')
    await writeFile(envFile, 'DEEPSEEK_API_KEY=legacy-secret\nKEEP=value\n', { mode: 0o600 })
    process.chdir(directory)
    try {
      const ctx = new Context()
      const fiber = ctx.plugin(KeychainCredentialProvider, { dshHome: join(directory, 'dsh-home') })
      await fiber
      assert.equal(await readFile(envFile, 'utf8'), 'DEEPSEEK_API_KEY=legacy-secret\nKEEP=value\n')
      await fiber.dispose()
    } finally { process.chdir(previous) }
  })
})

test('legacy credential symlinks are rejected without following or removing their target', async () => {
  await withDirectory(async directory => {
    const target = join(directory, 'target.yaml')
    const legacy = join(directory, '.credentials.yaml')
    await writeFile(target, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: legacy-secret\n', { mode: 0o600 })
    await symlink(target, legacy)
    const ctx = new Context()
    const fiber = ctx.plugin(KeychainCredentialProvider, { dshHome: directory })
    await fiber
    assert.match(await readFile(target, 'utf8'), /DEEPSEEK_API_KEY/u)
    await fiber.dispose()
  })
})

test('desktop-provided legacy roots import WSL-visible Windows credentials without copying their files', async () => {
  await withDirectory(async directory => {
    const providerUrl = new URL('../dist/index.js', import.meta.url).href
    const cordisUrl = pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
    const windowsHome = join(directory, 'windows-dsh-home')
    await mkdir(windowsHome, { recursive: true })
    const canonicalWindowsHome = await realpath(windowsHome)
    const source = `
      import assert from 'node:assert/strict'
      import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      const { default: Provider } = await import(process.env.CM_PROVIDER_URL)
      const { Context } = await import(process.env.CM_CORDIS_URL)
      const selected = join(process.env.CM_FIXTURE, 'linux-home')
      const legacy = join(process.env.CM_FIXTURE, 'windows-dsh-home')
      await mkdir(selected, { recursive: true })
      await mkdir(legacy, { recursive: true })
      const canonicalLegacy = await realpath(legacy)
      await writeFile(join(canonicalLegacy, '.credentials.yaml'), 'version: 1\\nrefs:\\n  MIGRATION_TEST_API_KEY: windows-secret\\n')
      await writeFile(join(canonicalLegacy, '.env'), 'MIGRATION_TEST_API_TOKEN=windows-token\\n')
      const values = new Map()
      const provider = new Provider(new Context(), { dshHome: selected, requestTimeoutMs: 1000 })
      provider.broker.close()
      provider.broker = {
        async get(reference) { return values.get(reference) },
        async setIfAbsent(reference, value) {
          if (values.has(reference)) return false
          values.set(reference, value)
          return true
        },
        close() {},
      }
      await provider.migrateLegacyCredentials()
      assert.equal(values.get('ref:MIGRATION_TEST_API_KEY'), 'windows-secret')
      assert.equal(values.get('ref:MIGRATION_TEST_API_TOKEN'), 'windows-token')
      await assert.rejects(readFile(join(canonicalLegacy, '.credentials.yaml')))
      assert.equal(await readFile(join(canonicalLegacy, '.env'), 'utf8'), '')
      const selectedFiles = await (await import('node:fs/promises')).readdir(selected)
      assert.ok(!selectedFiles.includes('.credentials.yaml'))
      assert.ok(!selectedFiles.includes('.env'))
      provider.broker.close()
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: join(directory, 'linux-user'),
        CM_FIXTURE: directory,
        CM_PROVIDER_URL: providerUrl,
        CM_CORDIS_URL: cordisUrl,
        CLAWMASTER_CREDENTIAL_LEGACY_ROOTS: JSON.stringify([canonicalWindowsHome]),
      },
      stdio: 'pipe',
    })
  })
})

test('two-home migration preserves sources on failure and cleans both homes after verified storage', async () => {
  await withDirectory(async directory => {
    const providerUrl = new URL('../dist/index.js', import.meta.url).href
    const cordisUrl = pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
    const source = `
      import assert from 'node:assert/strict'
        import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
      import { homedir } from 'node:os'
      import { join } from 'node:path'
      const { default: Provider } = await import(process.env.CM_PROVIDER_URL)
      const { Context } = await import(process.env.CM_CORDIS_URL)
        const selectedPath = join(process.env.CM_FIXTURE, 'selected')
        const defaultPath = join(homedir(), '.dsh')
        await mkdir(selectedPath, { recursive: true })
        await mkdir(defaultPath, { recursive: true })
        const selected = await realpath(selectedPath)
        const legacyHome = await realpath(defaultPath)
      await writeFile(join(selected, '.credentials.yaml'), 'version: 1\\nrefs:\\n  MIGRATION_TEST_ALPHA_API_KEY: alpha-secret\\n')
      await writeFile(join(selected, '.env'), '# selected comment\\r\\nMIGRATION_TEST_BETA_API_TOKEN=beta-secret\\r\\nKEEP_SELECTED=one  \\r\\n')
      await writeFile(join(legacyHome, '.credentials.yaml'), 'version: 1\\nrefs:\\n  MIGRATION_TEST_GAMMA_API_KEY: gamma-secret\\n')
      await writeFile(join(legacyHome, '.env'), 'KEEP_DEFAULT=two\\n')
      await writeFile(join(selected, '.clawmaster-credential-sources.json'), JSON.stringify({ version: 1, roots: [selected, legacyHome] }) + '\\n')
      const values = new Map()
      if (process.env.CM_MODE === 'conflict') values.set('ref:MIGRATION_TEST_ALPHA_API_KEY', 'different-existing-value')
      const store = {
        async get(reference) { return values.get(reference) },
        async set(reference, value) { values.set(reference, value) },
        async setIfAbsent(reference, value) {
          if (process.env.CM_MODE === 'unavailable') throw new Error('unavailable')
          if (values.has(reference)) return false
          values.set(reference, value)
          return true
        },
        async delete(reference) { values.delete(reference) },
        close() {},
      }
      const provider = new Provider(new Context(), { dshHome: selected, requestTimeoutMs: 1000 })
      provider.broker.close()
      provider.broker = store
      if (process.env.CM_MODE === 'unavailable') await assert.rejects(provider.migrateLegacyCredentials(), /unavailable/u)
      else await provider.migrateLegacyCredentials()
      if (process.env.CM_MODE !== 'success') {
        for (const root of [selected, legacyHome]) {
          assert.match(await readFile(join(root, '.credentials.yaml'), 'utf8'), /version: 1/u)
        }
        assert.match(await readFile(join(selected, '.env'), 'utf8'), /beta-secret/u)
        assert.equal(await readFile(join(legacyHome, '.env'), 'utf8'), 'KEEP_DEFAULT=two\\n')
      } else {
        assert.equal(values.get('ref:MIGRATION_TEST_ALPHA_API_KEY'), 'alpha-secret')
        assert.equal(values.get('ref:MIGRATION_TEST_BETA_API_TOKEN'), 'beta-secret')
        assert.equal(values.get('ref:MIGRATION_TEST_GAMMA_API_KEY'), 'gamma-secret')
        assert.equal(await readFile(join(selected, '.env'), 'utf8'), '# selected comment\\r\\nKEEP_SELECTED=one  \\r\\n')
        assert.equal(await readFile(join(legacyHome, '.env'), 'utf8'), 'KEEP_DEFAULT=two\\n')
        for (const root of [selected, legacyHome]) await assert.rejects(readFile(join(root, '.credentials.yaml')))
        await assert.rejects(readFile(join(selected, '.clawmaster-credential-sources.json')))
      }
      provider.broker.close()
    `
    for (const mode of ['unavailable', 'conflict', 'success']) {
      execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: directory,
        env: {
          ...process.env,
          HOME: join(directory, `user-${mode}`),
          CM_FIXTURE: join(directory, mode),
          CM_MODE: mode,
          CM_PROVIDER_URL: providerUrl,
          CM_CORDIS_URL: cordisUrl,
        },
        stdio: 'pipe',
      })
    }
  })
})
