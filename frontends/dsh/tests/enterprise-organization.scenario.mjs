import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceAccess } from '../src/governance-access.ts';
import { openEnterpriseStore, mountEnterpriseRoutes } from '../src/enterprise-host.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';
import { mountEnterpriseBackupRoutes } from '../src/enterprise-backup-host.ts';
import { enterpriseBackupConfigSchema } from '../src/enterprise-backup-config.ts';
import { mountWatchdogTasks as mountWatchdogTasksImpl } from '../src/watchdog-task-host.ts';
import { watchdogTaskTestContext } from './watchdog-task-test-context.mjs';

const mountWatchdogTasks = (context, ...args) => mountWatchdogTasksImpl(watchdogTaskTestContext(context), ...args);
import { mountWatchdogSchedules } from '../src/watchdog-schedule-host.ts';
import { openWatchdogScheduleStore } from '../src/watchdog-schedule-store.ts';
import { WatchdogScheduleRuntime } from '../src/watchdog-schedule-runtime.ts';

function accessFor(organizationId) {
  if (organizationId === 'local') return new GovernanceAccess();
  return new GovernanceAccess({ mode: 'enterprise', organizationId, authority: {
    async http() { return { organizationId, memberId: 'operator', actor: 'human' }; },
    async agent(sessionId) { return { organizationId, memberId: 'operator', actor: 'agent', sessionId }; },
    async membership() { return { active: true, roles: ['administrator', 'approver'], resources: ['*'], policyVersion: 1 }; },
    async consumeApproval() { return { id: 'approved', approverId: 'reviewer' }; },
  } });
}
async function setup(t, enterpriseOrg, scheduleOrg = enterpriseOrg) {
  const root = await mkdtemp(join(tmpdir(), 'enterprise-organization-'));
  const enterprise = await openEnterpriseStore(join(root, 'enterprise.sqlite'), 5000, enterpriseOrg);
  const schedules = await openWatchdogScheduleStore(join(root, 'schedule.sqlite'), scheduleOrg);
  const routes = new Map(), tools = new Map();
  let registrations = 0;
  const ctx = { connection: { fetch: { register(route) { registrations++; routes.set(route.path, route); return async () => routes.delete(route.path); } } },
    tools: { register(tool) { registrations++; tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => 'allowed-once' } };
  t.after(async () => { schedules.close(); enterprise.close(); await rm(root, { recursive: true, force: true }); });
  return { enterprise, schedules, routes, tools, ctx, registrations: () => registrations };
}
const mounts = {
  records: (h, access) => mountEnterpriseRoutes(h.ctx, h.enterprise, access),
  backups: (h, access) => mountEnterpriseBackupRoutes(h.ctx, h.enterprise, access, enterpriseBackupConfigSchema.parse({}), () => new Response(null, { status: 500 })),
  tools: (h, access) => applyEnterpriseTools(h.ctx, h.enterprise, {}, access),
  tasks: (h, access) => mountWatchdogTasks(h.ctx, h.enterprise, access),
  schedules: (h, access) => mountWatchdogSchedules(h.ctx, h.schedules, h.enterprise, access),
};
for (const [label, mount] of Object.entries(mounts)) {
  for (const [stored, configured] of [['local', 'acme'], ['acme', 'local'], ['acme', 'other']]) {
    test(`${label} rejects deployment mismatch ${configured} → ${stored} before any registration`, async t => {
      const h = await setup(t, stored);
      assert.equal(h.enterprise.organizationId, stored);
      await assert.rejects(mount(h, accessFor(configured)), /organization mismatch/);
      assert.equal(h.registrations(), 0); assert.equal(h.routes.size, 0); assert.equal(h.tools.size, 0);
      assert.equal(h.enterprise.overview().revision, 0); assert.equal(h.enterprise.responsibility().records.length, 0);
    });
  }
}
test('schedule consumers require both the ledger and responsibility owner to match', async t => {
  for (const [enterpriseOrg, scheduleOrg] of [['other', 'acme'], ['acme', 'other']]) {
    const h = await setup(t, enterpriseOrg, scheduleOrg);
    await assert.rejects(mounts.schedules(h, accessFor('acme')), /organization mismatch/);
    assert.equal(h.registrations(), 0);
  }
});
test('runtime refuses mismatched assembly before it can write a heartbeat or claim an occurrence', async t => {
  const h = await setup(t, 'acme');
  assert.throws(() => new WatchdogScheduleRuntime({}, h.schedules, accessFor('other')), /organization mismatch/);
  assert.throws(() => new WatchdogScheduleRuntime({}, h.schedules, accessFor('local')), /organization mismatch/);
});
test('local remains a reserved device namespace under enterprise configuration', async () => {
  const access = new GovernanceAccess({ mode: 'enterprise', organizationId: 'local', authority: {
    async http() {}, async agent() {}, async membership() {}, async consumeApproval() {},
  } });
  assert.throws(() => access.assertOrganization('local'), /organization mismatch/);
});
for (const organizationId of ['local', 'acme']) test(`matched ${organizationId} assembly serves records, tools, tasks and schedules`, async t => {
  const h = await setup(t, organizationId); const access = accessFor(organizationId);
  assert.throws(() => { h.enterprise.organizationId = 'other'; }, TypeError);
  const removals = [];
  try {
    for (const [name, mount] of Object.entries(mounts)) if (name !== 'backups') removals.push(await mount(h, access));
    for (const path of ['/api/clawmaster/enterprise', '/api/clawmaster/tasks', '/api/clawmaster/schedules']) {
      const response = await h.routes.get(path).fetch(new Request('http://fixture' + path));
      assert.equal(response.status, 200, await response.clone().text());
    }
    const command = { generation: 0, revision: 0, commandId: 'same-org-command', command: { type: 'contact.upsert', contact: {
      id: 'contact-one', name: 'Organization contact', company: '', stage: 'lead', nextAction: '', nextActionDate: null,
    } } };
    const response = await h.routes.get('/api/clawmaster/enterprise/command').fetch(new Request('http://fixture/api/clawmaster/enterprise/command', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const page = await h.tools.get('enterprise_query').execute({ collection: 'contacts', offset: 0, limit: 1 }, {
      agent: { id: 'session-one' }, callId: 'query-one', signal: new AbortController().signal,
    });
    assert.equal(page.total, 1); assert.equal(page.records[0].id, 'contact-one');
    assert.equal(h.enterprise.responsibility().records.at(-1).identity.organizationId, organizationId);
  } finally { for (const remove of removals.reverse()) await remove(); }
  assert.equal(h.routes.size, 0); assert.equal(h.tools.size, 0);
});
