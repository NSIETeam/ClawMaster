/** Produce an immutable self-contained plugin archive and a signable catalog candidate. */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = JSON.parse(await readFile(join(root, '../../package.json'), 'utf8'))
const stage = await mkdtemp(join(tmpdir(), 'clawmaster-updater-pack-'))
try {
  const pkg = join(stage, 'package')
  await mkdir(pkg)
  for (const name of ['dist', 'README.md', 'README.zh.md', 'component-signing.pub']) await cp(join(root, name), join(pkg, name), { recursive: true })
  const wasmName = '@threema/wasm-minisign-verify'
  await mkdir(join(pkg, 'node_modules/@threema'), { recursive: true })
  await cp(join(root, 'node_modules', wasmName), join(pkg, 'node_modules', wasmName), { recursive: true, dereference: true })
  const licenses = join(pkg, 'THIRD_PARTY_LICENSES')
  await mkdir(licenses)
  async function collectModules(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(parent, entry.name)
      if (entry.name.startsWith('@')) { await collectModules(path); continue }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const data = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
      for (const filename of await readdir(path)) {
        if (/^(?:license|copying|notice)(?:\.|$)/iu.test(filename)) await cp(join(path, filename), join(licenses, `${data.name.replaceAll('/', '__')}-${filename}`))
      }
    }
  }
  await collectModules(join(root, 'node_modules'))
  const packed = {
    name: manifest.name, version: manifest.version, description: manifest.description,
    private: true, type: 'module', license: manifest.license, engines: manifest.engines,
    exports: manifest.exports, peerDependencies: manifest.peerDependencies,
    dependencies: { [wasmName]: manifest.dependencies[wasmName] },
  }
  await writeFile(join(pkg, 'package.json'), `${JSON.stringify(packed, null, 2)}\n`)
  const filename = `clawmaster-dsh-updates-${manifest.version}.tgz`
  const output = join(root, 'artifacts')
  await mkdir(output, { recursive: true })
  const archive = join(output, filename)
  await create({ cwd: stage, file: archive, gzip: true, portable: true, mtime: new Date(0), noMtime: false }, ['package'])
  const bytes = await readFile(archive)
  const item = {
    id: 'updates', packageName: manifest.name, version: manifest.version,
    kind: 'component', entry: './dist/index.js', activation: 'restart',
    requiresDshVersion: source.version,
    url: `https://8.140.52.117/updates/clawmaster/components/artifacts/updates/${manifest.version}/${filename}`,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  }
  await writeFile(join(output, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), components: [item] }, null, 2)}\n`)
  await cp(join(root, 'dist/install.mjs'), join(output, `install-updates-${manifest.version}.mjs`))
  console.log(JSON.stringify({ archive, sha256: item.sha256, size: item.size }))
} finally { await rm(stage, { recursive: true, force: true }) }
