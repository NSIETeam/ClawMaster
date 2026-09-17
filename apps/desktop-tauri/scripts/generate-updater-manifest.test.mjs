import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createManifest,
  normalizedAssets,
  targetSetForPlatforms,
  parseArguments,
  resolveNotes,
  writeUpdaterManifest,
} from './generate-updater-manifest.mjs'

const version = '0.1.1-rc.2-0.3'
const repository = 'NSIETeam/ClawMaster-Desktop'
const releaseTag = `desktop-v${version}`
const pubDate = '2026-08-14T00:00:00.000Z'

const expectedAssets = {
  'windows-x86_64': `clawmaster-${version}-windows-x64-setup.exe`,
  'darwin-aarch64': `clawmaster-${version}-macos-arm64.app.tar.gz`,
  'linux-x86_64': `clawmaster-${version}-linux-x64.AppImage`,
  'linux-x86_64-deb': `clawmaster-${version}-linux-x64.deb`,
}

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-updater-'))
  try {
    await run(directory)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeAssets(directory) {
  for (const asset of Object.values(expectedAssets)) {
    await writeFile(join(directory, asset), 'release asset')
    await writeFile(join(directory, `${asset}.sig`), `  signature:${asset}  \n`)
  }
}

test('normalizedAssets maps every required Tauri platform to its release asset', () => {
  assert.deepEqual(normalizedAssets(version), expectedAssets)
})

test('only complete current, legacy, or beta platform target sets are accepted', () => {
  const legacy = normalizedAssets(version, 'legacy')
  assert.equal(Object.keys(legacy).length, 5)
  assert.equal(legacy['darwin-x86_64'], `clawmaster-${version}-macos-x64.app.tar.gz`)
  assert.equal(targetSetForPlatforms(expectedAssets), 'current')
  assert.equal(targetSetForPlatforms(legacy), 'legacy')
  const beta = normalizedAssets('0.2.4-beta.1', 'beta')
  assert.deepEqual(beta, {
    'windows-x86_64': 'clawmaster-0.2.4-beta.1-windows-x64-setup.exe',
    'darwin-aarch64': 'clawmaster-0.2.4-beta.1-macos-arm64.app.tar.gz',
  })
  assert.equal(targetSetForPlatforms(beta), 'beta')
  for (const platforms of [expectedAssets, legacy]) {
    for (const missing of Object.keys(expectedAssets)) {
      const altered = { ...platforms }
      delete altered[missing]
      assert.throws(() => targetSetForPlatforms(altered), /exactly a supported stable, legacy, or beta/u)
    }
    assert.throws(() => targetSetForPlatforms({ ...platforms, unknown: {} }), /exactly a supported stable, legacy, or beta/u)
  }
  for (const invalid of [null, [], 'current']) assert.throws(() => targetSetForPlatforms(invalid), /exactly a supported stable, legacy, or beta/u)
  assert.throws(() => normalizedAssets(version, 'windows-only'), /Invalid target set/)
  assert.throws(() => normalizedAssets(version, 'beta'), /beta.N version/u)
  assert.throws(() => normalizedAssets('0.2.4-beta.0', 'beta'), /beta.N version/u)
})

test('legacy generation requires Intel bytes and signatures while current generation does not', async () => {
  await withTempDir(async directory => {
    await writeAssets(directory)
    const outputPath = join(directory, 'latest.json')
    const options = { assetsDir: directory, outputPath, version, repository, releaseTag, notes: '', pubDate, targetSet: 'current' }
    await writeUpdaterManifest(options)
    const current = await readFile(outputPath, 'utf8')
    assert.equal(Object.keys(JSON.parse(current).platforms).length, 4)
    await assert.rejects(writeUpdaterManifest({ ...options, targetSet: 'legacy' }), /Missing release file.*macos-x64/)
    assert.equal(await readFile(outputPath, 'utf8'), current)
    const intel = normalizedAssets(version, 'legacy')['darwin-x86_64']
    await writeFile(join(directory, intel), 'legacy Intel asset')
    await writeFile(join(directory, `${intel}.sig`), 'legacy signature')
    await writeUpdaterManifest({ ...options, targetSet: 'legacy' })
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).platforms['darwin-x86_64'].signature, 'legacy signature')
  })
})

test('beta generation includes only Windows and macOS ARM64 installer payloads and signatures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'updater-beta-targets-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const betaVersion = '0.2.4-beta.1'
  const outputPath = join(directory, 'beta.json')
  const assets = normalizedAssets(betaVersion, 'beta')
  const signatures = {}
  for (const [platform, asset] of Object.entries(assets)) {
    await writeFile(join(directory, asset), `payload ${asset}`)
    signatures[platform] = `signature ${platform}`
    await writeFile(join(directory, `${asset}.sig`), signatures[platform])
  }
  await writeUpdaterManifest({ assetsDir: directory, outputPath, version: betaVersion, repository, releaseTag: `desktop-v${betaVersion}`,
    notes: '', pubDate, targetSet: 'beta' })
  const manifest = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(assets).sort())
  assert.deepEqual(Object.values(manifest.platforms).map(platform => platform.signature).sort(), Object.values(signatures).sort())
  assert.ok(Object.values(manifest.platforms).every(platform => platform.url.includes(`/desktop-v${betaVersion}/`)))
})

test('createManifest emits Tauri v2 static updater fields and trimmed signatures', () => {
  const signatures = Object.fromEntries(
    Object.entries(expectedAssets).map(([platform, asset]) => [platform, `  signature:${asset}\n`]),
  )

  assert.deepEqual(createManifest({
    version,
    repository,
    releaseTag,
    notes: 'Release candidate 5',
    pubDate,
    signatures,
  }), {
    version,
    notes: 'Release candidate 5',
    pub_date: pubDate,
    platforms: Object.fromEntries(
      Object.entries(expectedAssets).map(([platform, asset]) => [
        platform,
        {
          signature: `signature:${asset}`,
          url: `https://github.com/${repository}/releases/download/${releaseTag}/${asset}`,
        },
      ]),
    ),
  })
})

test('createManifest rejects invalid versions and publication dates', () => {
  const base = {
    version,
    repository,
    releaseTag,
    notes: '',
    pubDate,
    signatures: Object.fromEntries(Object.keys(expectedAssets).map(platform => [platform, 'sig'])),
  }

  assert.throws(() => createManifest({ ...base, version: 'release-5' }), /invalid version/i)
  assert.throws(() => createManifest({ ...base, pubDate: 'next Friday' }), /invalid pub date/i)
})

test('an HTTPS asset directory retains every platform filename and signature with either trailing slash', () => {
  const options = {
    version, repository, releaseTag, notes: 'Signed server mirror', pubDate,
    signatures: Object.fromEntries(Object.keys(expectedAssets).map(platform => [platform, `sig:${platform}`])),
  }
  const github = createManifest(options)
  const assetBaseUrl = `https://updates.example.test:8443/clawmaster/versions/${version}`
  for (const base of [assetBaseUrl, `${assetBaseUrl}/`]) {
    const mirrored = createManifest({ ...options, assetBaseUrl: base })
    assert.deepEqual({ ...mirrored, platforms: github.platforms }, github)
    for (const [platform, asset] of Object.entries(expectedAssets)) {
      assert.deepEqual(mirrored.platforms[platform], {
        ...github.platforms[platform], url: `${assetBaseUrl}/${asset}`,
      })
    }
  }
})

test('asset directories reject insecure, credential-bearing and ambiguously normalized URLs', () => {
  const options = {
    version, repository, releaseTag, notes: '', pubDate,
    signatures: Object.fromEntries(Object.keys(expectedAssets).map(platform => [platform, 'sig'])),
  }
  for (const assetBaseUrl of [
    '', 'updates.example.test/releases', '/releases', '//updates.example.test/releases',
    'http://updates.example.test/releases', 'file:///releases', 'https:/updates.example.test/releases',
    'https:///updates.example.test/releases', 'https://user:secret@updates.example.test/releases',
    'https://@updates.example.test/releases', 'https://updates.example.test/releases?token=secret',
    'https://updates.example.test:port/releases', 'https://[invalid]/releases',
    'https://updates.example.test/releases?', 'https://updates.example.test/releases#fragment',
    'https://updates.example.test/releases#', ' https://updates.example.test/releases',
    'https://updates.example.test/releases\n', 'https://updates.example.test\\releases',
    'https://updates.example.test/releases/../current', 'https://updates.example.test/releases/./current',
    'https://updates.example.test/releases//current', 'https://updates.example.test/%2e%2e/current',
    'https://updates.example.test/releases%2fcurrent', 'https://updates.example.test/releases%5ccurrent',
    'https://updates.example.test/releases%252fcurrent', 'https://updates.example.test/releases%00current',
    'https://updates.example.test/releases%20current', 'https://updates.example.test/releases%ZZcurrent',
  ]) {
    assert.throws(() => createManifest({ ...options, assetBaseUrl }), /invalid asset base url/i)
  }
})

test('writeUpdaterManifest rejects a missing normalized asset or signature', async () => {
  await withTempDir(async (directory) => {
    await writeAssets(directory)
    await rm(join(directory, `${expectedAssets['linux-x86_64']}.sig`))

    await assert.rejects(
      writeUpdaterManifest({
        assetsDir: directory,
        outputPath: join(directory, 'latest.json'),
        version,
        repository,
        releaseTag,
        notes: '',
        pubDate,
      }),
      /missing release file.*linux-x64\.AppImage\.sig/i,
    )
  })
})

test('DEB installations have a separately signed DEB update instead of an AppImage fallback', async () => {
  await withTempDir(async directory => {
    await writeAssets(directory)
    const outputPath = join(directory, 'latest.json')
    const options = { assetsDir: directory, outputPath, version, repository, releaseTag, notes: '', pubDate }
    await writeUpdaterManifest(options)
    const manifest = JSON.parse(await readFile(outputPath, 'utf8'))
    const deb = manifest.platforms['linux-x86_64-deb']
    assert.ok(deb.url.endsWith('.deb'))
    assert.equal(deb.signature, `signature:${expectedAssets['linux-x86_64-deb']}`)
    assert.ok(manifest.platforms['linux-x86_64'].url.endsWith('.AppImage'))
    await rm(join(directory, `${expectedAssets['linux-x86_64-deb']}.sig`))
    await assert.rejects(writeUpdaterManifest(options), /missing release file.*linux-x64\.deb\.sig/i)
  })
})

test('CLI accepts explicit arguments and writes latest.json', async () => {
  await withTempDir(async (directory) => {
    const assetsDir = join(directory, 'assets')
    const outputPath = join(directory, 'nested', 'latest.json')
    await mkdir(assetsDir)
    await writeAssets(assetsDir)

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./generate-updater-manifest.mjs', import.meta.url)),
      '--assets-dir', assetsDir,
      '--output', outputPath,
      '--version', version,
      '--repository', repository,
      '--release-tag', releaseTag,
      '--notes', 'Release candidate 5',
      '--pub-date', pubDate,
      '--target-set', 'current',
    ], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.platforms['darwin-aarch64'].signature,
      `signature:${expectedAssets['darwin-aarch64']}`)
  })
})

test('parseArguments requires every explicit CLI option', () => {
  assert.throws(
    () => parseArguments(['--assets-dir', 'assets']),
    /missing required option: --output/i,
  )
  const args = ['--assets-dir', 'assets', '--output', 'latest.json', '--version', version,
    '--repository', repository, '--release-tag', releaseTag, '--notes', '', '--pub-date', pubDate]
  assert.throws(() => parseArguments(args), /missing required option: --target-set/i)
  assert.throws(() => parseArguments([...args, '--target-set', 'partial']), /Invalid target set/)
  assert.throws(() => parseArguments([...args, '--target-set', 'current', '--target-set', 'legacy']), /Duplicate option/)
  assert.equal(parseArguments([...args, '--target-set', 'legacy']).targetSet, 'legacy')
})

test('parseArguments accepts --notes-file instead of --notes', () => {
  const values = parseArguments([
    '--assets-dir', 'assets',
    '--output', 'latest.json',
    '--version', version,
    '--repository', repository,
    '--release-tag', releaseTag,
    '--notes-file', 'release-notes.md',
    '--pub-date', pubDate,
      '--target-set', 'current',
  ])
  assert.equal(values.notesFile, 'release-notes.md')
  assert.equal(values.notes, undefined)
})

test('parseArguments rejects both --notes and --notes-file', () => {
  assert.throws(
    () => parseArguments([
      '--assets-dir', 'assets',
      '--output', 'latest.json',
      '--version', version,
      '--repository', repository,
      '--release-tag', releaseTag,
      '--notes', 'inline',
      '--notes-file', 'release-notes.md',
      '--pub-date', pubDate,
      '--target-set', 'current',
    ]),
    /either --notes or --notes-file/i,
  )
})

test('resolveNotes reads a bilingual notes file', async () => {
  await withTempDir(async (directory) => {
    const notesFile = join(directory, 'release-notes.md')
    await writeFile(notesFile, 'English notes\n\n中文说明\n')
    assert.equal(await resolveNotes({ notesFile }), 'English notes\n\n中文说明\n')
    assert.equal(await resolveNotes({ notes: 'inline' }), 'inline')
  })
})

test('CLI writes latest.json from --notes-file', async () => {
  await withTempDir(async (directory) => {
    const assetsDir = join(directory, 'assets')
    const outputPath = join(directory, 'latest.json')
    const notesFile = join(directory, 'release-notes.md')
    await mkdir(assetsDir)
    await writeAssets(assetsDir)
    await writeFile(notesFile, 'English\n\n中文\n')

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./generate-updater-manifest.mjs', import.meta.url)),
      '--assets-dir', assetsDir,
      '--output', outputPath,
      '--version', version,
      '--repository', repository,
      '--release-tag', releaseTag,
      '--notes-file', notesFile,
      '--pub-date', pubDate,
      '--target-set', 'current',
    ], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(manifest.notes, 'English\n\n中文\n')
  })
})

test('CLI writes a server manifest and leaves the current manifest intact on an invalid asset base', async () => {
  await withTempDir(async directory => {
    await writeAssets(directory)
    const outputPath = join(directory, 'latest.json')
    const args = [
      fileURLToPath(new URL('./generate-updater-manifest.mjs', import.meta.url)),
      '--assets-dir', directory,
      '--output', outputPath,
      '--version', version,
      '--repository', repository,
      '--release-tag', releaseTag,
      '--notes', 'Mirror publication',
      '--pub-date', pubDate,
      '--target-set', 'current',
      '--asset-base-url', `https://updates.example.test/clawmaster/versions/${version}`,
    ]
    const published = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 })
    assert.equal(published.error, undefined)
    assert.equal(published.signal, null)
    assert.equal(published.status, 0, published.stderr)
    const original = await readFile(outputPath, 'utf8')
    const manifest = JSON.parse(original)
    for (const [platform, asset] of Object.entries(expectedAssets)) {
      assert.deepEqual(manifest.platforms[platform], {
        signature: `signature:${asset}`,
        url: `https://updates.example.test/clawmaster/versions/${version}/${asset}`,
      })
      assert.equal(await readFile(join(directory, asset), 'utf8'), 'release asset')
      assert.equal(await readFile(join(directory, `${asset}.sig`), 'utf8'), `  signature:${asset}  \n`)
    }
    const rejected = spawnSync(process.execPath, [...args.slice(0, -1), 'https://operator:private-password@updates.example.test/releases'], {
      encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(rejected.error, undefined)
    assert.equal(rejected.signal, null)
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /invalid asset base url/i)
    assert.doesNotMatch(rejected.stderr, /operator|private-password/)
    assert.equal(await readFile(outputPath, 'utf8'), original)
  })
})
