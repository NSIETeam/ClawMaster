import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, runCapacity } from '../benchmarks/enterprise.perf.ts';

test('capacity report keeps tail samples and rejects invalid measurements', () => {
  assert.equal(percentile([2, 1, 3, 4, 100], 0.95), 100);
  assert.equal(percentile([2, 1, 3, 4, 100], 0.5), 3);
  assert.throws(() => percentile([], 0.5));
  assert.throws(() => percentile([NaN], 0.5));
  assert.throws(() => percentile([1], NaN));
});

test('capacity input limits reject unbounded workloads before creating workers', async () => {
  await assert.rejects(runCapacity([10001], 2));
  await assert.rejects(runCapacity([1], 1));
});

test('capacity diagnostic exercises built store writes, queries and restoration in isolated processes', async () => {
  const report = await runCapacity([10], 2);
  assert.equal(report.evidencePlane, 'diagnostic-route-artifact');
  assert.match(report.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.artifact.backupWorkerSha256, /^[a-f0-9]{64}$/);
  const [tier] = report.observations;
  assert.equal(tier.seededAuditEntries, 50);
  assert.equal(tier.samples.length, 2);
  assert.deepEqual(Object.keys(tier.metrics), ['open', 'overview', 'list', 'search', 'auditTail', 'saveReceipt', 'backup', 'prepareBackup', 'restore']);
  assert.ok(tier.metrics.backup.maxResponseBytes > tier.metrics.list.maxResponseBytes);
  assert.ok(tier.metrics.saveReceipt.maxResponseBytes < 400);
  assert.ok(tier.peakRssBytes > 0);
});
