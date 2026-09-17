import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPackageSizeReport, PACKAGE_OPTIMIZATION_TARGET_BYTES } from './package-size-report.mjs'

test('reports each beta installer size and keeps the 20 MiB target non-blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-size-report-'))
  try {
    const version = '0.2.4-beta.1'
    const names = [`clawmaster-${version}-windows-x64-setup.exe`, `clawmaster-${version}-macos-arm64.dmg`]
    await Promise.all(names.map((name, index) => writeFile(join(root, name), Buffer.alloc(index === 0 ? PACKAGE_OPTIMIZATION_TARGET_BYTES + 1 : 1024))))
    const report = await createPackageSizeReport({ assetsDir: root, version, sourceCommit: 'a'.repeat(40) })
    assert.deepEqual(report.installers.map(({ file, withinOptimizationTarget }) => ({ file, withinOptimizationTarget })), [
      { file: names[1], withinOptimizationTarget: true },
      { file: names[0], withinOptimizationTarget: false },
    ])
    assert.equal(report.optimizationTargetBytes, 20 * 1024 * 1024)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails when a required installer is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-size-report-missing-'))
  try {
    await assert.rejects(createPackageSizeReport({ assetsDir: root, version: '0.2.4-beta.1', sourceCommit: 'a'.repeat(40) }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
