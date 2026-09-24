/** The render probe must be pointable at any build run, and must fail on a blank window. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'

const workflow = load(readFileSync(new URL('../../../.github/workflows/csp-render-verify.yml', import.meta.url), 'utf8'))

/** @returns {object[]} Steps that fetch a build artifact. */
function downloadSteps(candidate) {
  return (candidate.jobs?.['render-verify']?.steps ?? []).filter(step => typeof step.run === 'string' && step.run.includes('gh run download'))
}

/**
 * @param {object} candidate A render-verify workflow document.
 * @returns {string | null} Why the download step cannot be pointed at another run, or null.
 */
function downloadTargetViolation(candidate) {
  const steps = downloadSteps(candidate)
  if (steps.length !== 1) return `expected one artifact download step, found ${String(steps.length)}`
  const run = steps[0].run
  if (!run.includes('$RENDER_RUN_ID')) return 'download step does not read $RENDER_RUN_ID'
  if (!run.includes('$RENDER_ARTIFACT')) return 'download step does not read $RENDER_ARTIFACT'
  if (!run.includes('--repo "$RENDER_REPOSITORY"')) return 'download step does not pass --repo "$RENDER_REPOSITORY"'
  return null
}

test('the render probe names the run, repository and artifact it renders', () => {
  const inputs = workflow.on.workflow_dispatch.inputs
  for (const name of ['repository', 'run_id', 'artifact']) assert.ok(inputs[name], name)
  assert.equal(inputs.run_id.required, true)
  assert.equal(inputs.run_id.default, undefined)
  assert.equal(inputs.repository.default, 'NSIETeam/ClawMaster')
  assert.equal(downloadTargetViolation(workflow), null)
})

test('a probe pinned to one historical payload is rejected', () => {
  const historical = {
    jobs: {
      'render-verify': {
        steps: [{
          name: 'Download the beta.1 macos payload',
          run: 'mkdir -p "$RUNNER_TEMP/payload"\ngh run download 35450188820 --repo NSIETeam/ClawMaster-Desktop -n desktop-macos-arm64 -D "$RUNNER_TEMP/payload"\n',
        }],
      },
    },
  }
  assert.equal(downloadTargetViolation(historical), 'download step does not read $RENDER_RUN_ID')
  const hardcodedRepo = { jobs: { 'render-verify': { steps: [{ run: 'gh run download $RENDER_RUN_ID --repo NSIETeam/ClawMaster-Desktop -n "$RENDER_ARTIFACT" -D x' }] } } }
  assert.equal(downloadTargetViolation(hardcodedRepo), 'download step does not pass --repo "$RENDER_REPOSITORY"')
  const twoDownloads = { jobs: { 'render-verify': { steps: [{ run: 'gh run download $RENDER_RUN_ID --repo "$RENDER_REPOSITORY" -n "$RENDER_ARTIFACT" -D x' }, { run: 'gh run download $RENDER_RUN_ID' }] } } }
  assert.equal(downloadTargetViolation(twoDownloads), 'expected one artifact download step, found 2')
})

test('the probe fails on a blank window and keeps its evidence', () => {
  const render = workflow.jobs['render-verify'].steps.find(step => step.name === 'Render in a real browser and assert')
  assert.match(render.run, /rootChildren > 0 && state\.loader === 'live'/u)
  assert.match(render.run, /process\.exitCode = 1/u)
  assert.match(render.run, /VERDICT: FAIL - blank window/u)
  const upload = workflow.jobs['render-verify'].steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(upload.if, 'always()')
  assert.match(upload.with.path, /render-proof\.png/u)
  assert.match(upload.with.path, /host\.log/u)
})
