import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceAccess } from '../src/governance-access.ts';
import { mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';

function authorityFixture() {
  const members = new Map([
    ['alice', { active: true, roles: ['executor'], resources: ['*'], policyVersion: 1 }],
    ['bob', { active: true, roles: ['approver'], resources: ['*'], policyVersion: 1 }],
    ['audit', { active: true, roles: ['auditor'], resources: ['*'], policyVersion: 1 }],
    ['admin', { active: true, roles: ['administrator'], resources: ['*'], policyVersion: 1 }],
  ]);
  const principals = new Map();
  const grants = new Map();
  const authority = {
    http: async request => principals.get(request.headers.get('authorization')),
    agent: async id => principals.get(id),
    membership: async (organizationId, memberId) => organizationId === 'one' ? members.get(memberId) : undefined,
    consumeApproval: async request => { const key = JSON.stringify(request); const grant = grants.get(key); grants.delete(key); return grant; },
  };
  for (const memberId of members.keys()) principals.set(memberId, { organizationId: 'one', memberId, actor: 'human' });
  principals.set('session-alice', { organizationId: 'one', memberId: 'alice', actor: 'agent', sessionId: 'session-alice' });
  const access = new GovernanceAccess({ mode: 'enterprise', organizationId: 'one', authority });
  return { members, principals, grants, authority, access };
}

test('current roles and resource grants are rechecked after revocation, including delegator limits', async () => {
  const h = authorityFixture();
  const alice = await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }));
  assert.equal((await alice.check('records.write')).principalId, 'alice');
  await assert.rejects(alice.check('audit.read'), { code: 'permission_denied' });
  h.members.set('alice', { active: true, roles: ['executor'], resources: ['customer-one'], policyVersion: 2 });
  await assert.rejects(alice.check('records.read'), { code: 'permission_denied' });
  assert.equal((await alice.check('records.read', 'customer-one')).policyVersion, 2);
  h.members.set('alice', { active: false, roles: ['executor'], resources: ['*'], policyVersion: 3 });
  await assert.rejects(alice.check('records.write', 'customer-one'), { code: 'permission_denied' });
  h.principals.set('child', { organizationId: 'one', memberId: 'admin', actor: 'agent', sessionId: 'child', delegatorId: 'alice' });
  const child = await h.access.agent('child');
  await assert.rejects(child.check('records.write'), { code: 'permission_denied' });
});

test('approval is object/revision/digest bound, single use and separated from the executor', async () => {
  const h = authorityFixture();
  const alice = await h.access.agent('session-alice', 'call-1');
  const request = { organizationId: 'one', executorId: 'alice', action: 'records.write', resource: 'customer', commandId: 'write-1', generation: 0, revision: 5, commandDigest: 'digest' };
  h.grants.set(JSON.stringify(request), { id: 'self-grant', approverId: 'alice' });
  await assert.rejects(alice.approve('records.write', 'customer', 'write-1', 0, 5, 'digest'), { code: 'permission_denied' });
  h.grants.set(JSON.stringify(request), { id: 'valid-grant', approverId: 'bob' });
  await assert.rejects(alice.approve('records.write', 'customer', 'write-1', 1, 5, 'digest'), { code: 'permission_denied' });
  const approved = await alice.approve('records.write', 'customer', 'write-1', 0, 5, 'digest');
  assert.equal(approved.approval.approverId, 'bob');
  await assert.rejects(alice.approve('records.write', 'customer', 'write-1', 0, 5, 'digest'), { code: 'permission_denied' });
});

test('HTTP read/export/write paths refuse cross-organization and missing identity without local fallback', async t => {
  const h = authorityFixture();
  h.principals.set('other', { organizationId: 'two', memberId: 'admin', actor: 'human' });
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { await dispose(); store.close(); });
  for (const path of ['/api/clawmaster/enterprise', '/api/clawmaster/enterprise/backup', '/api/clawmaster/enterprise/responsibility']) {
    for (const identity of ['other', '']) assert.equal((await routes.get(path)(new Request(`http://fixture${path}`, { headers: { authorization: identity } }))).status, 403);
  }
  const command = { type: 'contact.upsert', contact: { id: 'customer', name: 'Reviewed', company: '', stage: 'lead', nextAction: '', nextActionDate: null } };
  const request = { generation: 0, revision: 0, commandId: 'write', command };
  const send = identity => routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', { method: 'POST', headers: { authorization: identity, 'content-type': 'application/json' }, body: JSON.stringify(request) }));
  assert.equal((await send('other')).status, 403);
  assert.equal((await send('alice')).status, 403);
  h.grants.set(JSON.stringify({ organizationId: 'one', executorId: 'alice', action: 'records.write', resource: 'customer', commandId: 'write', generation: 0, revision: 0,
    commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex') }), { id: 'approved-write', approverId: 'bob' });
  assert.equal((await send('alice')).status, 200);
  assert.equal((await send('alice')).status, 200);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().contacts[0].name, 'Reviewed');
  h.authority.http = async () => { throw new Error('Authority unavailable'); };
  assert.equal((await send('alice')).status, 503);
  assert.equal(store.snapshot().revision, 1);
});

test('revocation while a tool awaits DSH approval prevents the queued write', async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const tools = new Map();
  let release; let arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const approval = new Promise(resolve => { release = resolve; });
  const remove = await applyEnterpriseTools({ tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => { arrived(); return approval; } } }, store, {}, h.access);
  t.after(async () => { release('cancelled'); await remove(); store.close(); });
  const operation = tools.get('enterprise_command').execute({ request: { generation: 0, revision: 0, commandId: 'queued',
    command: { type: 'contact.upsert', contact: { id: 'customer', name: 'Not saved', company: '', stage: 'lead', nextAction: '', nextActionDate: null } } } },
    { agent: { id: 'session-alice' }, callId: 'call', name: 'enterprise_command', signal: new AbortController().signal });
  await waiting;
  h.members.set('alice', { active: false, roles: ['executor'], resources: ['*'], policyVersion: 2 });
  release('allowed-once');
  await assert.rejects(operation, { code: 'permission_denied' });
  assert.equal(store.snapshot().revision, 0);
});

test('database organization binding blocks accidental local-data migration and cross-organization reuse', async t => {
  const root = await mkdtemp(join(tmpdir(), 'organization-binding-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'records.sqlite');
  const store = await openEnterpriseStore(path, 5000, 'one'); store.close();
  await assert.rejects(openEnterpriseStore(path, 5000, 'two'), { code: 'storage_invalid' });
  await assert.rejects(openEnterpriseStore(path), { code: 'storage_invalid' });
  const local = await openEnterpriseStore(join(root, 'local.sqlite')); local.close();
  await assert.rejects(openEnterpriseStore(join(root, 'local.sqlite'), 5000, 'one'), { code: 'storage_invalid' });
});
