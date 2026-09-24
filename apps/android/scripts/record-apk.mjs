/** Bind a release APK to source bytes, checksum and signing purpose. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const apk = process.argv[2]
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('APK source is not clean')
const record = {
  schemaVersion: 1,
  product: 'ClawMaster standalone Android',
  version: '0.0.1',
  versionCode: 203,
  gitCommit: git('rev-parse', 'HEAD'),
  gitTree: git('rev-parse', 'HEAD^{tree}'),
  sha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
  signingPurpose: 'persistent-android-release-key',
}
writeFileSync(apk + '.build.json', JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record))
