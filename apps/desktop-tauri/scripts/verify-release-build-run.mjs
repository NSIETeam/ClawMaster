/** Verify that publication consumes an immutable successful candidate build run. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** @param {object} run GitHub Actions workflow-run response. @param {{runId:number,commit:string,tag:string,repository:string}} expected Candidate identity and repository. @returns {{runId:number,attempt:number,commit:string}} Verified original run identity. */
export function verifyReleaseBuildRun(run, expected) {
  assert.equal(run.repository?.full_name, expected.repository, 'Build run belongs to another repository')
  assert.match(run.path ?? '', /\.github\/workflows\/desktop-release\.yml(?:@.*)?$/u, 'Build run used another workflow')
  assert.equal(run.status, 'completed', 'Candidate build run is not complete')
  assert.equal(run.conclusion, 'success', 'Candidate build run did not succeed')
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'Candidate build run has an unsupported trigger')
  assert.equal(run.head_sha, expected.commit, 'Build run source differs from the release tag commit')
  assert.equal(run.id, expected.runId, 'GitHub returned another build run ID')
  assert.equal(run.run_attempt > 0, true, 'Build run attempt is invalid')
  assert.equal(run.id > 0, true, 'Build run ID is invalid')
  assert.equal(expected.tag.startsWith('desktop-v'), true, 'Release tag is invalid')
  return { runId: run.id, attempt: run.run_attempt, commit: run.head_sha }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'run-file': { type: 'string' }, 'run-id': { type: 'string' }, commit: { type: 'string' }, tag: { type: 'string' }, repository: { type: 'string' } } })
  assert.ok(values['run-file'] && values['run-id'] && values.commit && values.tag && values.repository,
    'Required: --run-file <GitHub API JSON> --run-id <id> --commit <full SHA> --tag <desktop-v*> --repository <owner/name>')
  const result = verifyReleaseBuildRun(JSON.parse(await readFile(values['run-file'], 'utf8')),
    { runId: Number(values['run-id']), commit: values.commit, tag: values.tag, repository: values.repository })
  console.log(`Verified original build run ${result.runId} attempt ${result.attempt} for ${result.commit}`)
}
