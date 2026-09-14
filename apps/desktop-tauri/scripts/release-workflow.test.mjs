/** Build-only dispatch retains release checks without publishing or moving Latest. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'

const workflow = load(readFileSync(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8'))

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
  for (const name of ['dsh', 'notes', 'office', 'guard', 'graph-memory', 'rpa']) {
    assert.ok(step.run.includes(`npm ci --prefix frontends/${name} --ignore-scripts`), name)
  }
  const bundle = workflow.jobs.build.steps.find(entry => entry.name === 'Build desktop bundles')
  assert.equal(bundle.env.TAURI_SIGNING_PRIVATE_KEY, '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}')
  assert.ok(workflow.jobs.build.steps.some(entry => entry.name === 'Verify installed Windows desktop and normal relaunch'))
})
