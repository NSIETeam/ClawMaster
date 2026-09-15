import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createManifest, normalizedAssets } from './generate-updater-manifest.mjs'
import { parseArguments, syncUpdaterChannel } from './sync-updater-channel.mjs'

// The public rust-minisign-verify vector authenticates the exact bytes "test" without a private key.
const publicKey = Buffer.from(`untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
`).toString('base64')
const signature = Buffer.from(`untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==
`).toString('base64')
const repository = 'NSIETeam/ClawMaster-Desktop'
const baseUrl = 'https://updates.example.test/clawmaster'
const minisign = process.env.CLAWMASTER_MINISIGN ?? 'minisign'
const sha256 = value => createHash('sha256').update(value).digest('hex')

function releaseFixture(version = '0.2.1') {
  const targets = normalizedAssets(version)
  const tag = `desktop-v${version}`
  const manifest = createManifest({ version, repository, releaseTag: tag,
    notes: 'Verified desktop release', pubDate: '2026-09-15T00:00:00Z',
    signatures: Object.fromEntries(Object.keys(targets).map(target => [target, signature])) })
  const files = new Map(Object.values(targets).flatMap(name => [[name, 'test'], [`${name}.sig`, `${signature}\n`]]))
  files.set('latest.json', `${JSON.stringify(manifest)}\n`)
  const fixture = { version, tag, targets, manifest, files, release: null, requests: [] }
  fixture.refresh = () => {
    files.set('SHA256SUMS.txt', [...files].filter(([name]) => name !== 'SHA256SUMS.txt').map(([name, contents]) => `${sha256(contents)}  ${name}`).join('\n') + '\n')
    fixture.release = { tag_name: tag, draft: false, prerelease: false, assets: [...files].map(([name, contents], index) => ({
      id: index + 1, name, size: Buffer.byteLength(contents), digest: `sha256:${sha256(contents)}`,
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    })) }
  }
  fixture.refresh()
  fixture.fetchImpl = async (url, options) => {
    fixture.requests.push(url)
    assert.ok(options.signal instanceof AbortSignal)
    if (url === `https://api.github.com/repos/${repository}/releases/latest`) {
      assert.equal(options.headers.Accept, 'application/vnd.github+json')
      return new Response(JSON.stringify(fixture.release))
    }
    const asset = fixture.release.assets.find(entry => entry.browser_download_url === url)
    assert.ok(asset, `unexpected request: ${url}`)
    return new Response(files.get(asset.name))
  }
  return fixture
}

async function withState(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-update-channel-'))
  try {
    const publicKeyPath = join(root, 'release.pub')
    await writeFile(publicKeyPath, publicKey, { flag: 'wx', mode: 0o600 })
    const options = { stateDir: join(root, 'state'), publicKeyPath, baseUrl, minisign }
    await run({ root, options, latest: join(options.stateDir, 'public', 'latest.json') })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function aria2Fixture(root, mode) {
  const executable = join(root, `aria2-${mode}`)
  const record = join(root, `aria2-${mode}.jsonl`)
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const directory = args.find(value => value.startsWith('--dir=')).slice(6)
const name = args.find(value => value.startsWith('--out=')).slice(6)
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, pid: process.pid, secretKeys: Object.keys(process.env).filter(key => /KEY|SECRET|TOKEN|PASSWORD/i.test(key)) }) + '\\n')
fs.writeFileSync(path.join(directory, name), ${JSON.stringify(mode === 'partial' ? 'tes' : 'test')}, { flag: 'wx' })
if (${JSON.stringify(mode)} === 'nonzero') process.exit(42)
if (${JSON.stringify(mode)} === 'timeout') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
`, { flag: 'wx', mode: 0o700 })
  await chmod(executable, 0o700)
  return { executable, record }
}

test('publishing verifies original signatures, preserves asset bytes and serves rewritten HTTPS URLs', async () => {
  await withState(async ({ options, latest }) => {
    const fixture = releaseFixture()
    assert.deepEqual(await syncUpdaterChannel(options, fixture), { status: 'published', version: '0.2.1' })
    const output = JSON.parse(await readFile(latest, 'utf8'))
    const directory = join(options.stateDir, 'public', 'versions', '0.2.1')
    for (const [target, name] of Object.entries(fixture.targets)) {
      assert.deepEqual(output.platforms[target], { signature, url: `${baseUrl}/versions/0.2.1/${name}` })
      assert.equal(await readFile(join(directory, name), 'utf8'), 'test')
    }
    assert.equal(await readFile(join(directory, 'latest.json'), 'utf8'), await readFile(latest, 'utf8'))
    const sums = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')
    assert.ok(sums.includes(`${sha256(await readFile(latest))}  latest.json`))
    const evidence = join(options.stateDir, 'evidence', '0.2.1')
    assert.equal(await readFile(join(evidence, 'latest.json'), 'utf8'), fixture.files.get('latest.json'))
    assert.equal(await readFile(join(evidence, 'SHA256SUMS.txt'), 'utf8'), fixture.files.get('SHA256SUMS.txt'))
    assert.ok((await readdir(options.stateDir)).every(name => !name.startsWith('.stage-')))
    if (process.platform !== 'win32') {
      assert.equal((await lstat(evidence)).mode & 0o777, 0o700)
      assert.equal((await lstat(directory)).mode & 0o777, 0o755)
      assert.equal((await lstat(latest)).mode & 0o777, 0o644)
    }
  })
})

test('the same version validates its immutable files without downloading or replacing metadata', async () => {
  await withState(async ({ options, latest }) => {
    const fixture = releaseFixture()
    await syncUpdaterChannel(options, fixture)
    const before = await lstat(latest)
    fixture.requests.length = 0
    assert.deepEqual(await syncUpdaterChannel(options, fixture), { status: 'current', version: '0.2.1' })
    assert.equal(fixture.requests.length, 1)
    assert.equal((await lstat(latest)).ino, before.ino)
    assert.equal((await lstat(latest)).mtimeMs, before.mtimeMs)
    fixture.release.assets[0].id += 100
    await assert.rejects(syncUpdaterChannel(options, fixture), /Immutable release metadata differs/)
  })
})

test('exclusive startup removes abandoned download directories while retaining unrelated files and links', async () => {
  await withState(async ({ root, options }) => {
    await mkdir(options.stateDir)
    const abandoned = await mkdtemp(join(options.stateDir, '.stage-'))
    await writeFile(join(abandoned, 'partial-download'), 'unfinished bytes')
    const unrelated = join(options.stateDir, 'business-record')
    await writeFile(unrelated, 'retained')
    const external = join(root, 'unrelated-directory')
    await mkdir(external)
    await writeFile(join(external, 'keep'), 'retained')
    const linked = join(options.stateDir, '.stage-abcdef')
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await syncUpdaterChannel(options, releaseFixture())
      await assert.rejects(lstat(abandoned), { code: 'ENOENT' })
      assert.ok((await lstat(linked)).isSymbolicLink())
      assert.equal(await readFile(unrelated, 'utf8'), 'retained')
      assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'retained')
    }
    finally {
      await unlink(linked)
    }
  })
})

test('a completed immutable directory is promoted after an interrupted latest-manifest switch', async () => {
  await withState(async ({ options, latest }) => {
    await syncUpdaterChannel(options, releaseFixture())
    const old = await readFile(latest, 'utf8')
    const newer = releaseFixture('0.2.2')
    await syncUpdaterChannel(options, newer)
    const completed = await readFile(latest, 'utf8')
    const immutable = join(options.stateDir, 'public', 'versions', '0.2.2')
    const before = await lstat(immutable)
    await writeFile(latest, old)
    newer.requests.length = 0
    assert.deepEqual(await syncUpdaterChannel(options, newer), { status: 'published', version: '0.2.2' })
    assert.equal(newer.requests.length, 1)
    assert.equal(await readFile(latest, 'utf8'), completed)
    assert.equal((await lstat(immutable)).ino, before.ino)
  })
})

test('downgrades, drafts, prereleases and unrelated tags cannot replace the current channel', async () => {
  await withState(async ({ options, latest }) => {
    await syncUpdaterChannel(options, releaseFixture())
    const current = await readFile(latest, 'utf8')
    const older = releaseFixture('0.2.0')
    await assert.rejects(syncUpdaterChannel(options, older), /downgrade/)
    assert.equal(older.requests.length, 1)
    for (const metadata of [{ draft: true }, { prerelease: true }, { tag_name: 'desktop-v0.2.2-beta.1' }, { tag_name: 'v0.2.2' }]) {
      const next = releaseFixture('0.2.2')
      Object.assign(next.release, metadata)
      await assert.rejects(syncUpdaterChannel(options, next), /published stable desktop release/)
      assert.equal(next.requests.length, 1)
    }
    assert.equal(await readFile(latest, 'utf8'), current)
  })
})

test('asset-set omissions and redirected source locations fail before download', async () => {
  await withState(async ({ options }) => {
    for (const edit of [
      fixture => fixture.release.assets.pop(),
      fixture => fixture.release.assets.push(fixture.release.assets[0]),
      fixture => { fixture.release.assets[0].browser_download_url = 'https://other.example.test/file.exe' },
      fixture => { fixture.release.assets[0].size = -1 },
    ]) {
      const fixture = releaseFixture()
      edit(fixture)
      await assert.rejects(syncUpdaterChannel(options, fixture), /Missing or invalid GitHub release asset/)
      assert.equal(fixture.requests.length, 1)
    }
  })
})

test('checksum tampering and invalid signed bytes leave the old manifest intact', async () => {
  await withState(async ({ options, latest }) => {
    await syncUpdaterChannel(options, releaseFixture())
    const current = await readFile(latest, 'utf8')
    for (const refreshChecksum of [false, true]) {
      const next = releaseFixture('0.2.2')
      next.files.set(next.targets['windows-x86_64'], 'evil')
      if (refreshChecksum) next.refresh()
      await assert.rejects(syncUpdaterChannel(options, next), refreshChecksum ? /signature verification failed/ : /Release checksum mismatch/)
      assert.equal(await readFile(latest, 'utf8'), current)
      assert.ok(!(await readdir(join(options.stateDir, 'public', 'versions'))).includes('0.2.2'))
      assert.ok((await readdir(options.stateDir)).every(name => !name.startsWith('.stage-')))
    }
  })
})

test('failed, truncated and oversized downloads cannot publish a partial version', async () => {
  await withState(async ({ options, latest }) => {
    await syncUpdaterChannel(options, releaseFixture())
    const current = await readFile(latest, 'utf8')
    for (const failure of ['http', 'truncated', 'oversized', 'stream']) {
      const next = releaseFixture('0.2.2')
      const original = next.fetchImpl
      next.fetchImpl = async (url, request) => {
        if (url.endsWith('windows-x64-setup.exe')) {
          if (failure === 'http') return new Response('unavailable', { status: 503 })
          if (failure === 'truncated') return new Response('tes')
          if (failure === 'oversized') return new Response('test-extra')
          return new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection interrupted')) } }))
        }
        return original(url, request)
      }
      await assert.rejects(syncUpdaterChannel(options, next), /request failed|Incomplete release download|exceeds declared size|connection interrupted/)
      assert.equal(await readFile(latest, 'utf8'), current)
      assert.ok(!(await readdir(join(options.stateDir, 'public', 'versions'))).includes('0.2.2'))
    }
  })
})

test('optional aria2 downloads only the five artifacts with isolated verified transfers', { skip: process.platform === 'win32' ? 'The test-owned executable uses a POSIX shebang; production server runs Linux.' : false }, async () => {
  await withState(async ({ root, options, latest }) => {
    const downloader = await aria2Fixture(root, 'complete')
    const fixture = releaseFixture()
    assert.deepEqual(await syncUpdaterChannel({ ...options, aria2: downloader.executable }, fixture), { status: 'published', version: '0.2.1' })
    const calls = (await readFile(downloader.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.length, 5)
    for (const call of calls) {
      for (const flag of ['--no-conf', '--no-netrc=true', '--enable-rpc=false', '--follow-torrent=false', '--follow-metalink=false',
        '--check-certificate=true', '--async-dns=false', '--split=8', '--max-connection-per-server=8', '--min-split-size=1M',
        '--allow-overwrite=false', '--auto-file-renaming=false', '--file-allocation=none', '--max-tries=3', '--connect-timeout=30', '--timeout=60']) {
        assert.ok(call.args.includes(flag), flag)
      }
      const outputDir = call.args.find(value => value.startsWith('--dir=')).slice(6)
      assert.ok(outputDir.startsWith(join(options.stateDir, '.stage-')))
      assert.ok(outputDir.endsWith('/source'))
      const name = call.args.find(value => value.startsWith('--out=')).slice(6)
      assert.ok(Object.values(fixture.targets).includes(name))
      assert.equal(call.args.at(-1), `https://github.com/${repository}/releases/download/desktop-v0.2.1/${name}`)
      assert.deepEqual(call.secretKeys, [])
      assert.ok(!fixture.requests.includes(call.args.at(-1)))
    }
    assert.equal(fixture.requests.length, 8)
    assert.equal(JSON.parse(await readFile(latest, 'utf8')).version, '0.2.1')
  })
})

test('aria2 failure or incomplete output cannot advance the current manifest', { skip: process.platform === 'win32' ? 'The test-owned executable uses a POSIX shebang; production server runs Linux.' : false }, async () => {
  await withState(async ({ root, options, latest }) => {
    await syncUpdaterChannel(options, releaseFixture())
    const current = await readFile(latest, 'utf8')
    for (const mode of ['nonzero', 'partial']) {
      const downloader = await aria2Fixture(root, mode)
      await assert.rejects(syncUpdaterChannel({ ...options, aria2: downloader.executable }, releaseFixture('0.2.2')), mode === 'nonzero'
        ? error => {
          assert.match(error.message, /Segmented release download failed/)
          assert.equal(error.cause.code, 42)
          assert.equal(error.cause.signal, null)
          return true
        } : /Incomplete segmented release download/)
      assert.equal(await readFile(latest, 'utf8'), current)
      assert.ok((await readdir(options.stateDir)).every(name => !name.startsWith('.stage-')))
    }
  })
})

test('aria2 timeout kills and awaits the transfer before staging cleanup', { skip: process.platform === 'win32' ? 'The test proves POSIX process exit after SIGKILL on the Linux-server path.' : false }, async () => {
  await withState(async ({ root, options }) => {
    const downloader = await aria2Fixture(root, 'timeout')
    const fixture = releaseFixture()
    let transferPid
    await assert.rejects(syncUpdaterChannel({ ...options, aria2: downloader.executable }, {
      ...fixture,
      executeFileImpl: (executable, args, execution) => {
        assert.equal(execution.timeout, 600_000)
        assert.equal(execution.killSignal, 'SIGKILL')
        return new Promise((resolve, reject) => {
          const child = execFile(executable, args, { ...execution, timeout: 1000 }, (error, stdout, stderr) => {
            if (error) reject(error)
            else resolve({ stdout, stderr })
          })
          transferPid = child.pid
        })
      },
    }), error => {
      assert.match(error.message, /Segmented release download failed/)
      assert.equal(error.cause.killed, true)
      assert.equal(error.cause.signal, 'SIGKILL')
      return true
    })
    assert.equal(typeof transferPid, 'number')
    assert.throws(() => process.kill(transferPid, 0), { code: 'ESRCH' })
    assert.ok((await readdir(options.stateDir)).every(name => !name.startsWith('.stage-')))
    assert.deepEqual(await readdir(join(options.stateDir, 'public', 'versions')), [])
  })
})

test('altered manifest versions, URLs and signatures fail before promotion', async () => {
  await withState(async ({ options }) => {
    for (const edit of [
      manifest => { manifest.version = '0.2.0' },
      manifest => { manifest.platforms['windows-x86_64'].url = 'https://other.example.test/file.exe' },
      manifest => { manifest.platforms['windows-x86_64'].signature = 'invalid-signature' },
    ]) {
      const fixture = releaseFixture()
      edit(fixture.manifest)
      fixture.files.set('latest.json', JSON.stringify(fixture.manifest))
      fixture.refresh()
      await assert.rejects(syncUpdaterChannel(options, fixture), /Source manifest differs|Source updater URL differs|signature differs/)
      assert.deepEqual(await readdir(join(options.stateDir, 'public', 'versions')), [])
    }
  })
})

test('same-version publication rejects damaged local assets and inconsistent current metadata', async () => {
  await withState(async ({ options, latest }) => {
    const fixture = releaseFixture()
    await syncUpdaterChannel(options, fixture)
    const current = await readFile(latest, 'utf8')
    const artifact = join(options.stateDir, 'public', 'versions', '0.2.1', fixture.targets['windows-x86_64'])
    await writeFile(artifact, 'evil')
    await assert.rejects(syncUpdaterChannel(options, fixture), /Release checksum mismatch/)
    await writeFile(artifact, 'test')
    await writeFile(latest, JSON.stringify({ ...JSON.parse(current), notes: 'changed' }))
    await assert.rejects(syncUpdaterChannel(options, fixture), /Current manifest differs/)
  })
})

test('CLI options require normalized paths and an explicit HTTPS destination', async () => {
  await withState(async ({ options }) => {
    const args = ['--state-dir', options.stateDir, '--public-key', options.publicKeyPath, '--base-url', `${baseUrl}/`]
    assert.deepEqual(parseArguments(args), { ...options, repository, minisign: 'minisign' })
    assert.equal(parseArguments([...args, '--aria2', '/usr/bin/aria2c']).aria2, '/usr/bin/aria2c')
    assert.throws(() => parseArguments([...args, '--aria2', '']), /aria2 executable/)
    for (const bad of [[], [...args, '--unknown', 'value'], [...args, '--base-url', baseUrl],
      [...args.slice(0, -1), 'http://updates.example.test/channel'], ['--state-dir', './relative', ...args.slice(2)]]) {
      assert.throws(() => parseArguments(bad), /absolute|HTTPS|option|baseUrl/)
    }
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./sync-updater-channel.mjs', import.meta.url)), '--base-url', 'http://invalid.example.test'])
      .then(() => assert.fail('invalid CLI configuration succeeded'), error => error)
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.match(result.stderr, /absolute normalized path/)
  })
})
