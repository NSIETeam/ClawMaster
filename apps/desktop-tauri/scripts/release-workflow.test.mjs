/** Build-only dispatch retains release checks without publishing or moving Latest. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'

const workflow = load(readFileSync(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8'))

test('the committed desktop lock is unambiguous and includes graph persistence', () => {
  const lock = load(readFileSync(new URL('../pnpm-desktop-lock.yaml', import.meta.url), 'utf8'))
  for (const name of ['dsh', 'notes', 'office', 'guard', 'graph-memory', 'rpa', 'updates']) {
    assert.ok(lock.importers[`frontends/${name}`], name)
  }
  assert.equal(lock.importers['frontends/graph-memory'].dependencies['@deepseek-ai/dsh-storage-sqlite'].version,
    'link:../../packages/storage/storage-sqlite')
})

test('manual validation defaults to an immutable branch build without publication', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.type, 'boolean')
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false)
  assert.equal(workflow.jobs.release.if, "github.event_name == 'push' || inputs.publish == true")
  assert.equal(workflow.jobs.release.needs, 'build')
  const checkout = workflow.jobs.build.steps.find(step => step.uses === 'actions/checkout@v6')
  assert.equal(checkout.with.ref, '${{ github.event_name == \'workflow_dispatch\' && !inputs.publish && github.sha || env.RELEASE_TAG }}')
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(entry => [entry.asset_platform, entry.asset_arch]), [
    ['windows', 'x64'], ['macos', 'x64'], ['macos', 'arm64'], ['linux', 'x64'],
  ])
})

test('every shipped frontend has frozen build dependencies before product verification', () => {
  const step = workflow.jobs.build.steps.find(entry => entry.name === 'Install product frontend build dependencies')
  for (const name of ['dsh', 'notes', 'office', 'guard', 'graph-memory', 'rpa', 'updates']) {
    assert.ok(step.run.includes(`npm ci --prefix frontends/${name} --ignore-scripts`), name)
  }
  const bundle = workflow.jobs.build.steps.find(entry => entry.name === 'Build desktop bundles')
  assert.equal(bundle.env.TAURI_SIGNING_PRIVATE_KEY, '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}')
  assert.ok(workflow.jobs.build.steps.some(entry => entry.name === 'Verify installed Windows desktop and normal relaunch'))
  assert.ok(workflow.jobs.build.steps.some(entry => entry.name === 'Verify macOS acceptance prerequisites' && entry.run.includes('--preflight')))
  const mac = workflow.jobs.build.steps.find(entry => entry.name === 'Verify installed macOS desktop and normal relaunch')
  assert.ok(mac.run.includes('verify-macos-native.mjs'))
  assert.ok(!mac.run.includes('--close-mode terminate'))
})

test('WeChat approval replay runs on Unix after its built runtime and before packaging', () => {
  const steps = workflow.jobs.build.steps
  const replay = steps.findIndex(step => step.name === 'Replay approved and rejected WeChat reads')
  assert.ok(replay > steps.findIndex(step => step.name === 'Build ClawMaster harness'))
  assert.ok(replay > steps.findIndex(step => step.name === 'Build complete Linux sandbox binaries'))
  assert.ok(replay < steps.findIndex(step => step.name === 'Build desktop bundles'))
  assert.equal(steps[replay].if, "runner.os == 'macOS' || runner.os == 'Linux'")
  assert.equal(steps[replay].run, "pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/acp/acp.snapshot.ts -t 'snapshot: wechat-read-(approved|rejected) matches|snapshot fixtures'")
})
