import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { auditGovernanceOutcome, GovernanceAccess, governanceResource, governanceResourceCollection } from '../src/governance-access.ts';
import { mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';
import { mountWatchdogTasks as mountWatchdogTasksImpl } from '../src/watchdog-task-host.ts';
import { watchdogTaskTestContext } from './watchdog-task-test-context.mjs';

const mountWatchdogTasks = (context, ...args) => mountWatchdogTasksImpl(watchdogTaskTestContext(context), ...args);
import { applyManagedWorkspaces } from '../src/workspace-host.ts';

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

for (const phase of ['http', 'agent', 'membership', 'consumeApproval', 'owner']) test(`cancellation fences ${phase} and does not continue a late authorization`, async () => {
  const h = authorityFixture(); const control = new AbortController();
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  const key = phase === 'owner' ? 'membership' : phase;
  const original = h.authority[key];
  h.authority[key] = async (...args) => {
    assert.equal(args.at(-1), control.signal);
    arrived.resolve(); await release.promise;
    return original(...args);
  };
  let consumed = 0;
  if (phase !== 'consumeApproval') h.authority.consumeApproval = async () => { consumed++; return undefined; };
  const start = async () => {
    if (phase === 'http') return h.access.http(new Request('http://fixture'), control.signal);
    const caller = await h.access.agent('session-alice', 'cancelled-operation', control.signal);
    if (phase === 'agent') return caller;
    if (phase === 'owner') return caller.checkOwner({ kind: 'member', id: 'alice' });
    return caller.approve('records.write', governanceResource('record/contact', 'customer'), 'command', 0, 0, 'digest');
  };
  let settled = false;
  const failure = new Error('Operation stopped');
  const result = start().then(() => ({ ok: true }), error => { settled = true; return { error }; });
  await arrived.promise; control.abort(failure); await new Promise(setImmediate);
  const cancelledBeforeProviderFinished = settled;
  release.resolve(); const output = await result; await new Promise(setImmediate);
  assert.equal(cancelledBeforeProviderFinished, true);
  assert.equal(output.error, failure);
  assert.equal(consumed, 0, 'A late membership result must not initiate approval consumption.');
});

test('task consumer unload cancels an unresolved identity without waiting for the provider or writing later', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  h.authority.http = async () => { arrived.resolve(); await release.promise; return h.principals.get('alice'); };
  const routes = new Map();
  const remove = await mountWatchdogTasks({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' } }, store, h.access);
  t.after(async () => { release.resolve(); await remove(); store.close(); });
  const result = routes.get('/api/clawmaster/tasks')(new Request('http://fixture/api/clawmaster/tasks'));
  await arrived.promise;
  let closed = false; const closing = remove().then(() => { closed = true; });
  await new Promise(setImmediate); const beforeRelease = closed;
  release.resolve(); await closing;
  assert.equal(beforeRelease, true);
  assert.equal((await result).status, 503);
  assert.equal(store.responsibility().records.length, 0);
});

test('current roles and resource grants are rechecked after revocation, including delegator limits', async () => {
  const h = authorityFixture();
  const alice = await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }));
  assert.equal((await alice.check('records.write')).principalId, 'alice');
  await assert.rejects(alice.check('audit.read'), { code: 'permission_denied' });
  h.members.set('alice', { active: true, roles: ['executor'], resources: ['customer-one'], policyVersion: 2 });
  await assert.rejects(alice.check('records.read', 'customer-one'), { code: 'permission_denied' }, 'bare resource IDs are not valid enterprise resource keys');
  const contactResource = governanceResource('record/contact', 'customer-one');
  await assert.rejects(alice.check('records.read', contactResource), { code: 'permission_denied' });
  h.members.set('alice', { active: true, roles: ['executor'], resources: [contactResource], policyVersion: 2 });
  await assert.rejects(alice.check('records.read'), { code: 'permission_denied' });
  assert.equal((await alice.check('records.read', contactResource)).policyVersion, 2);
  h.members.set('alice', { active: false, roles: ['executor'], resources: ['*'], policyVersion: 3 });
  await assert.rejects(alice.check('records.write', contactResource), { code: 'permission_denied' });
  h.principals.set('child', { organizationId: 'one', memberId: 'admin', actor: 'agent', sessionId: 'child', delegatorId: 'alice' });
  const child = await h.access.agent('child');
  await assert.rejects(child.check('records.write'), { code: 'permission_denied' });
});

test('resource-family wildcard grants do not cross record, task or workspace families', async () => {
  const h = authorityFixture();
  h.members.set('alice', { active: true, roles: ['executor'], resources: [governanceResourceCollection('record/contact')], policyVersion: 4 });
  const caller = await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }));
  assert.equal((await caller.check('records.read', governanceResource('record/contact', 'same-id'))).policyVersion, 4);
  await assert.rejects(caller.check('records.read', governanceResource('record/inventory', 'same-id')), { code: 'permission_denied' });
  await assert.rejects(caller.check('records.write', governanceResource('task', 'same-id')), { code: 'permission_denied' });
  await assert.rejects(caller.check('workspace.create', governanceResource('workspace', 'task')), { code: 'permission_denied' });
});

test('order submission requires write permission for every referenced inventory item', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one'); const routes = new Map();
  let approvalRequests = 0;
  h.authority.consumeApproval = async () => { approvalRequests++; return { id: 'unused', approverId: 'bob' }; };
  const remove = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { await remove(); store.close(); });
  store.execute({ generation: 0, revision: 0, commandId: 'seed-stock', command: { type: 'item.upsert', item: {
    id: 'item-one', sku: 'SKU-1', name: 'Restricted stock', stock: 1, reorderAt: 0, supplier: '',
  } } });
  store.execute({ generation: 0, revision: 1, commandId: 'seed-order', command: { type: 'order.save', order: {
    id: 'order-one', kind: 'sale', counterparty: 'Buyer', orderDate: '2026-09-17', currency: 'CNY',
    lines: [{ itemId: 'item-one', quantity: 1, unitPriceMinorUnits: 100 }], note: '',
  } } });
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [governanceResource('record/order', 'order-one')], policyVersion: 2 });
  const response = await routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', { method: 'POST',
    headers: { authorization: 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ generation: 0, revision: 2,
      commandId: 'submit-order', command: { type: 'order.submit', id: 'order-one' } }) }));
  assert.equal(response.status, 403);
  assert.equal(approvalRequests, 0, 'the approval provider is not called when an affected stock item is outside scope');
  assert.equal(store.snapshot().revision, 2);
  assert.equal(store.snapshot().inventory[0].stock, 1);
  assert.equal(store.snapshot().orders[0].status, 'draft');
});

test('HTTP order submission rechecks inventory grants after independent approval and records the final policy version', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one'); const routes = new Map();
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  h.authority.consumeApproval = async () => { arrived.resolve(); await release.promise; return { id: 'inventory-approval', approverId: 'bob' }; };
  const remove = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { release.resolve(); await remove(); store.close(); });
  store.execute({ generation: 0, revision: 0, commandId: 'seed-stock', command: { type: 'item.upsert', item: { id: 'item-one', sku: 'SKU-1', name: 'Stock', stock: 1, reorderAt: 0, supplier: '' } } });
  store.execute({ generation: 0, revision: 1, commandId: 'seed-order', command: { type: 'order.save', order: { id: 'order-one', kind: 'sale', counterparty: 'Buyer', orderDate: '2026-09-17', currency: 'CNY', lines: [{ itemId: 'item-one', quantity: 1, unitPriceMinorUnits: 100 }], note: '' } } });
  const orderResource = governanceResource('record/order', 'order-one');
  const itemResource = governanceResource('record/inventory', 'item-one');
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [orderResource, itemResource], policyVersion: 2 });
  h.grants.set(JSON.stringify({ organizationId: 'one', executorId: 'alice', action: 'records.write', resource: orderResource, commandId: 'submit-http', generation: 0, revision: 2,
    commandDigest: createHash('sha256').update(JSON.stringify({ type: 'order.submit', id: 'order-one' })).digest('hex') }), { id: 'approved-submit', approverId: 'bob' });
  const result = routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', { method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' },
    body: JSON.stringify({ generation: 0, revision: 2, commandId: 'submit-http', command: { type: 'order.submit', id: 'order-one' } }) }));
  await arrived.promise;
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [orderResource], policyVersion: 3 });
  release.resolve();
  assert.equal((await result).status, 403);
  assert.equal(store.snapshot().inventory[0].stock, 1);
  assert.equal(store.snapshot().orders[0].status, 'draft');
  assert.equal(store.responsibility().records.at(-1).outcome, 'denied');
  assert.equal(store.responsibility().records.at(-1).identity.approval.id, 'inventory-approval');
});

test('HTTP order submission records the final policy version and retains its independent approval', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one'); const routes = new Map();
  h.authority.consumeApproval = async () => {
    h.members.set('alice', { active: true, roles: ['administrator'], resources: [governanceResource('record/order', 'order-one'), governanceResource('record/inventory', 'item-one')], policyVersion: 4 });
    return { id: 'approved-version-change', approverId: 'bob' };
  };
  const remove = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { await remove(); store.close(); });
  store.execute({ generation: 0, revision: 0, commandId: 'seed-stock', command: { type: 'item.upsert', item: { id: 'item-one', sku: 'SKU-1', name: 'Stock', stock: 1, reorderAt: 0, supplier: '' } } });
  store.execute({ generation: 0, revision: 1, commandId: 'seed-order', command: { type: 'order.save', order: { id: 'order-one', kind: 'sale', counterparty: 'Buyer', orderDate: '2026-09-17', currency: 'CNY', lines: [{ itemId: 'item-one', quantity: 1, unitPriceMinorUnits: 100 }], note: '' } } });
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [governanceResource('record/order', 'order-one'), governanceResource('record/inventory', 'item-one')], policyVersion: 2 });
  const command = { type: 'order.submit', id: 'order-one' };
  const response = await routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', { method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' },
    body: JSON.stringify({ generation: 0, revision: 2, commandId: 'submit-version', command }) }));
  assert.equal(response.status, 200, await response.clone().text());
  const finalRecord = store.responsibility().records.find(record => record.commandId === 'submit-version');
  assert.equal(finalRecord.identity.policyVersion, 4);
  assert.equal(finalRecord.identity.approval.id, 'approved-version-change');
  assert.equal(store.snapshot().inventory[0].stock, 0);
});

test('the final order and inventory check uses one membership snapshot', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one'); const routes = new Map();
  const originalMembership = h.authority.membership; let aliceMembershipReads = 0;
  h.authority.membership = async (organizationId, memberId, signal) => {
    // The fifth Alice read is the final post-approval check after order, inventory, and approval-bound checks.
    if (memberId === 'alice' && ++aliceMembershipReads === 5) {
      return { active: true, roles: ['administrator'], resources: [governanceResource('record/inventory', 'item-one')], policyVersion: 5 };
    }
    return originalMembership(organizationId, memberId, signal);
  };
  h.authority.consumeApproval = async () => ({ id: 'approved-submit', approverId: 'bob' });
  const remove = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { await remove(); store.close(); });
  store.execute({ generation: 0, revision: 0, commandId: 'seed-stock', command: { type: 'item.upsert', item: { id: 'item-one', sku: 'SKU-1', name: 'Stock', stock: 1, reorderAt: 0, supplier: '' } } });
  store.execute({ generation: 0, revision: 1, commandId: 'seed-order', command: { type: 'order.save', order: { id: 'order-one', kind: 'sale', counterparty: 'Buyer', orderDate: '2026-09-17', currency: 'CNY', lines: [{ itemId: 'item-one', quantity: 1, unitPriceMinorUnits: 100 }], note: '' } } });
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [governanceResource('record/order', 'order-one'), governanceResource('record/inventory', 'item-one')], policyVersion: 2 });
  const response = await routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', { method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' },
    body: JSON.stringify({ generation: 0, revision: 2, commandId: 'submit-shared-snapshot', command: { type: 'order.submit', id: 'order-one' } }) }));
  assert.equal(response.status, 403);
  assert.equal(store.snapshot().inventory[0].stock, 1);
  assert.equal(store.snapshot().orders[0].status, 'draft');
  assert.equal(store.responsibility().records.at(-1).identity.approval.id, 'approved-submit');
});

test('DSH order submission rechecks inventory grants after the real tool approval wait', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one'); const ctx = new Context();
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  ctx.on('approval/request', async () => { arrived.resolve(); await release.promise; return 'allowed-once'; });
  const remove = await applyEnterpriseTools(ctx, store, {}, h.access);
  t.after(async () => { release.resolve(); await remove(); await ctx.fiber.dispose(); store.close(); });
  store.execute({ generation: 0, revision: 0, commandId: 'seed-stock', command: { type: 'item.upsert', item: { id: 'item-one', sku: 'SKU-1', name: 'Stock', stock: 1, reorderAt: 0, supplier: '' } } });
  store.execute({ generation: 0, revision: 1, commandId: 'seed-order', command: { type: 'order.save', order: { id: 'order-one', kind: 'sale', counterparty: 'Buyer', orderDate: '2026-09-17', currency: 'CNY', lines: [{ itemId: 'item-one', quantity: 1, unitPriceMinorUnits: 100 }], note: '' } } });
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [governanceResource('record/order', 'order-one'), governanceResource('record/inventory', 'item-one')], policyVersion: 2 });
  const input = { request: { generation: 0, revision: 2, commandId: 'submit-tool', command: { type: 'order.submit', id: 'order-one' } } };
  h.grants.set(JSON.stringify({ organizationId: 'one', executorId: 'alice', action: 'records.write', resource: governanceResource('record/order', 'order-one'), commandId: input.request.commandId,
    generation: 0, revision: 2, commandDigest: createHash('sha256').update(JSON.stringify(input.request.command)).digest('hex') }), { id: 'tool-approved-submit', approverId: 'bob' });
  const session = Session.create(SessionId('session-alice'));
  session.append('turn/start', { turn: 1 });
  const operation = ctx.tools.execute({ name: 'enterprise_command', arguments: input, agent: { id: session.id, session }, callId: 'submit-call', signal: new AbortController().signal });
  await arrived.promise;
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [governanceResource('record/order', 'order-one')], policyVersion: 3 });
  release.resolve();
  const result = await operation;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /authenticated caller cannot perform/);
  assert.equal(store.snapshot().inventory[0].stock, 1);
  assert.equal(store.snapshot().orders[0].status, 'draft');
  assert.equal(store.responsibility().records.at(-1).outcome, 'denied');
});

test('approval is object/revision/digest bound, single use and separated from the executor', async () => {
  const h = authorityFixture();
  const alice = await h.access.agent('session-alice', 'call-1');
  const resource = governanceResource('record/contact', 'customer');
  const request = { organizationId: 'one', executorId: 'alice', action: 'records.write', resource, commandId: 'write-1', generation: 0, revision: 5, commandDigest: 'digest' };
  h.grants.set(JSON.stringify(request), { id: 'self-grant', approverId: 'alice' });
  await assert.rejects(alice.approve('records.write', resource, 'write-1', 0, 5, 'digest'), { code: 'permission_denied' });
  h.grants.set(JSON.stringify(request), { id: 'valid-grant', approverId: 'bob' });
  await assert.rejects(alice.approve('records.write', resource, 'write-1', 1, 5, 'digest'), { code: 'permission_denied' });
  const approved = await alice.approve('records.write', resource, 'write-1', 0, 5, 'digest');
  assert.equal(approved.approval.kind, 'authority');
  assert.equal(approved.approval.approverId, 'bob');
  await assert.rejects(alice.approve('records.write', resource, 'write-1', 0, 5, 'digest'), { code: 'permission_denied' });
  assert.equal(alice.identity.approval, undefined, 'a failed new approval attempt does not retain an earlier receipt');
  h.members.set('bob', { active: true, roles: ['approver'], resources: [governanceResourceCollection('record/contact')], policyVersion: 2 });
  h.grants.set(JSON.stringify(request), { id: 'family-grant', approverId: 'bob' });
  const familyApproved = await alice.approve('records.write', resource, 'write-1', 0, 5, 'digest');
  assert.equal(familyApproved.approval.id, 'family-grant');
});

test('an approval consumed before the post-consumption permission check remains in the denial audit', async t => {
  const h = authorityFixture(); const store = await openEnterpriseStore(':memory:', 5000, 'one');
  t.after(() => store.close());
  const resource = governanceResource('record/contact', 'customer');
  h.members.set('alice', { active: true, roles: ['administrator'], resources: [resource], policyVersion: 2 });
  h.authority.consumeApproval = async () => {
    h.members.set('alice', { active: false, roles: ['administrator'], resources: [], policyVersion: 3 });
    return { id: 'consumed-then-revoked', approverId: 'bob' };
  };
  const caller = await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }));
  await assert.rejects(auditGovernanceOutcome(caller, store, 'records.write', 'revoked-during-approval', () =>
    caller.approve('records.write', resource, 'revoked-during-approval', 0, 0, 'digest')), { code: 'permission_denied' });
  const [entry] = store.responsibility().records;
  assert.equal(entry.outcome, 'denied');
  assert.equal(entry.identity.approval.id, 'consumed-then-revoked');
  assert.equal(entry.identity.approval.approverId, 'bob');
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
  assert.equal(store.responsibility().records.length, 0, 'unresolved or foreign callers are never attributed as local humans');
  assert.equal((await send('alice')).status, 403);
  const denied = store.responsibility().records;
  assert.equal(denied.length, 1);
  assert.equal(denied[0].identity.actor.id, 'alice');
  assert.equal(denied[0].outcome, 'denied');
  assert.equal(denied[0].operation, 'contact.upsert');
  assert.equal(denied[0].reasonCode, 'approval_missing');
  assert.equal(denied[0].identity.policyVersion, 1);
  assert.ok(!JSON.stringify(denied).includes('Reviewed'));
  h.grants.set(JSON.stringify({ organizationId: 'one', executorId: 'alice', action: 'records.write', resource: governanceResource('record/contact', 'customer'), commandId: 'write', generation: 0, revision: 0,
    commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex') }), { id: 'approved-write', approverId: 'bob' });
  assert.equal((await send('alice')).status, 200);
  assert.equal((await send('alice')).status, 200);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().contacts[0].name, 'Reviewed');
  h.authority.http = async () => { throw new Error('Authority unavailable'); };
  assert.equal((await send('alice')).status, 503);
  assert.equal(store.snapshot().revision, 1);
});

test('workspace allocation checks live organization identity and the requested resource before creating a directory', async t => {
  const h = authorityFixture();
  h.members.set('alice', { active: true, roles: ['executor'], resources: [governanceResource('workspace', 'task')], policyVersion: 2 });
  const root = await mkdtemp(join(tmpdir(), 'workspace-governance-'));
  const managedRoot = join(root, 'workspaces');
  t.after(() => rm(root, { force: true, recursive: true }));
  const routes = new Map();
  const created = [];
  const dispose = applyManagedWorkspaces({
    workspaceRegistry: { async create(path) { created.push(path); return { id: 'workspace', path }; } },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
  }, managedRoot, h.access);
  t.after(dispose);
  const send = (identity, kind) => routes.get('/api/clawmaster/workspace')(new Request('http://fixture/api/clawmaster/workspace', {
    method: 'POST', headers: identity === undefined ? {} : { authorization: identity }, body: JSON.stringify({ kind }),
  }));

  assert.equal((await send('other', 'task')).status, 403);
  assert.equal((await send(undefined, 'task')).status, 403);
  assert.equal((await send('alice', 'tools')).status, 403, 'a task-only grant cannot allocate the tools workspace');
  assert.deepEqual(created, []);
  await assert.rejects(stat(managedRoot), { code: 'ENOENT' });

  assert.equal((await send('alice', 'task')).status, 200);
  assert.equal(created.length, 1);
  h.authority.http = async () => { throw new Error('Authority unavailable'); };
  assert.equal((await send('alice', 'task')).status, 503, 'authority outage does not fall back to local access');
  assert.equal(created.length, 1);
});

test('workspace allocation rechecks membership before creating its directory', async t => {
  const h = authorityFixture();
  const root = await mkdtemp(join(tmpdir(), 'workspace-before-mkdir-'));
  const managedRoot = join(root, 'workspaces');
  t.after(() => rm(root, { force: true, recursive: true }));
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  h.authority.membership = async (_organizationId, memberId) => {
    arrived.resolve(); await release.promise;
    return memberId === 'alice' ? { active: false, roles: ['executor'], resources: ['*'], policyVersion: 2 } : h.members.get(memberId);
  };
  const routes = new Map(); const created = [];
  const dispose = applyManagedWorkspaces({
    workspaceRegistry: { async create(path) { created.push(path); return { id: 'workspace', path }; } },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
  }, managedRoot, h.access);
  t.after(dispose);
  const pending = routes.get('/api/clawmaster/workspace')(new Request('http://fixture/api/clawmaster/workspace', {
    method: 'POST', headers: { authorization: 'alice' }, body: JSON.stringify({ kind: 'task' }),
  }));
  await arrived.promise;
  release.resolve();
  assert.equal((await pending).status, 403);
  assert.deepEqual(created, []);
  await assert.rejects(stat(managedRoot), { code: 'ENOENT' });
});

test('workspace allocation removes its empty directory when membership is revoked before registration', async t => {
  const h = authorityFixture();
  const root = await mkdtemp(join(tmpdir(), 'workspace-before-register-'));
  const managedRoot = join(root, 'workspaces');
  t.after(() => rm(root, { force: true, recursive: true }));
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  let membershipReads = 0;
  h.authority.membership = async (_organizationId, memberId) => {
    if (memberId === 'alice' && ++membershipReads === 2) { arrived.resolve(); await release.promise; }
    return h.members.get(memberId);
  };
  const routes = new Map(); const created = [];
  const dispose = applyManagedWorkspaces({
    workspaceRegistry: { async create(path) { created.push(path); return { id: 'workspace', path }; } },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
  }, managedRoot, h.access);
  t.after(dispose);
  const pending = routes.get('/api/clawmaster/workspace')(new Request('http://fixture/api/clawmaster/workspace', {
    method: 'POST', headers: { authorization: 'alice' }, body: JSON.stringify({ kind: 'task' }),
  }));
  await arrived.promise;
  assert.deepEqual(await readdir(join(managedRoot, 'tasks')).then(entries => entries.length), 1, 'the allocation directory exists while final authorization is pending');
  h.members.set('alice', { active: false, roles: ['executor'], resources: ['*'], policyVersion: 3 });
  release.resolve();
  assert.equal((await pending).status, 403);
  assert.equal(membershipReads, 2);
  assert.deepEqual(created, []);
  assert.deepEqual(await readdir(join(managedRoot, 'tasks')), [], 'revocation removes the empty allocated directory');
});

test('a revoked desk allocation cannot remove the desk registered by a concurrent authorized caller', async t => {
  const h = authorityFixture();
  h.members.set('bob', { active: true, roles: ['executor'], resources: [governanceResource('workspace', 'tools')], policyVersion: 2 });
  const root = await mkdtemp(join(tmpdir(), 'workspace-shared-desk-'));
  const managedRoot = join(root, 'workspaces'); const desk = join(managedRoot, 'desk');
  t.after(() => rm(root, { force: true, recursive: true }));
  const aliceFinalCheck = Promise.withResolvers(); const releaseAlice = Promise.withResolvers();
  const bobIdentityResolved = Promise.withResolvers(); let aliceMembershipReads = 0;
  h.authority.membership = async (_organizationId, memberId) => {
    if (memberId === 'alice' && ++aliceMembershipReads === 2) { aliceFinalCheck.resolve(); await releaseAlice.promise; }
    return h.members.get(memberId);
  };
  const originalHttp = h.authority.http;
  h.authority.http = async request => {
    if (request.headers.get('authorization') === 'bob') bobIdentityResolved.resolve();
    return originalHttp(request);
  };
  const routes = new Map(); const created = [];
  const dispose = applyManagedWorkspaces({
    workspaceRegistry: { async create(path) { created.push(path); return { id: `workspace-${created.length}`, path }; } },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
  }, managedRoot, h.access);
  t.after(dispose);
  const send = (identity, kind) => routes.get('/api/clawmaster/workspace')(new Request('http://fixture/api/clawmaster/workspace', {
    method: 'POST', headers: { authorization: identity }, body: JSON.stringify({ kind }),
  }));
  const revoked = send('alice', 'tools');
  await aliceFinalCheck.promise;
  assert.ok(await stat(desk), 'the first caller created the shared directory before its final authorization');

  const authorized = send('bob', 'tools');
  await bobIdentityResolved.promise;
  h.members.set('alice', { active: false, roles: ['executor'], resources: [], policyVersion: 3 });
  releaseAlice.resolve();

  assert.equal((await revoked).status, 403);
  assert.equal((await authorized).status, 200);
  assert.deepEqual(created, [desk]);
  assert.ok((await stat(desk)).isDirectory());
});

test('workspace consumer unload cancels an unresolved identity without waiting or allocating later', async t => {
  const h = authorityFixture();
  const root = await mkdtemp(join(tmpdir(), 'workspace-unload-'));
  const managedRoot = join(root, 'workspaces');
  t.after(() => rm(root, { force: true, recursive: true }));
  const arrived = Promise.withResolvers(); const release = Promise.withResolvers();
  let authoritySignal;
  h.authority.http = async (_request, signal) => {
    authoritySignal = signal;
    arrived.resolve();
    await release.promise;
    return h.principals.get('alice');
  };
  const routes = new Map(); const created = [];
  const dispose = applyManagedWorkspaces({
    workspaceRegistry: { async create(path) { created.push(path); return { id: 'workspace', path }; } },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } },
  }, managedRoot, h.access);
  t.after(async () => { release.resolve(); await dispose(); });
  const pending = routes.get('/api/clawmaster/workspace')(new Request('http://fixture/api/clawmaster/workspace', {
    method: 'POST', headers: { authorization: 'alice' }, body: JSON.stringify({ kind: 'task' }),
  }));
  await arrived.promise;

  await dispose();
  assert.equal(authoritySignal.aborted, true);
  assert.equal((await pending).status, 503);
  release.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(created, []);
  await assert.rejects(stat(managedRoot), { code: 'ENOENT' });
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
  const [entry] = store.responsibility().records;
  assert.equal(entry.outcome, 'denied');
  assert.equal(entry.commandId, 'queued');
  assert.equal(entry.identity.actor.kind, 'agent');
  assert.equal(entry.identity.principalId, 'alice');
  assert.equal(entry.identity.callId, 'call');
  assert.equal(entry.identity.policyVersion, 2, 'denial records the revoked policy version');
  assert.equal(entry.reasonCode, 'permission_denied');
  assert.ok(!JSON.stringify(entry).includes('Not saved'));
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

test('global counts require broad access while scoped reads and writes expose only their authorized resource', async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map(); const tools = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  const disposeTools = await applyEnterpriseTools({ tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, approval: { request: async () => 'allowed-once' } }, store, {}, h.access);
  t.after(async () => { await disposeTools(); await dispose(); store.close(); });
  store.execute({ generation: 0, revision: 0, commandId: 'secret-seed', command: { type: 'contact.upsert',
    contact: { id: 'secret', name: 'Confidential customer', company: 'Private contract', stage: 'lead', nextAction: '', nextActionDate: null } } });
  const read = identity => routes.get('/api/clawmaster/enterprise')(new Request('http://fixture/enterprise', { headers: { authorization: identity } }));
  assert.equal((await read('alice')).status, 403, 'records.read does not authorize audit counts');
  assert.equal((await read('admin')).status, 200);
  h.members.set('alice', { active: true, roles: ['executor'], resources: [governanceResource('record/contact', 'customer')], policyVersion: 2 });
  h.members.set('audit', { active: true, roles: ['auditor'], resources: [governanceResource('record/contact', 'customer')], policyVersion: 2 });
  assert.equal((await read('audit')).status, 403, 'scoped audit permission cannot inspect global counts');
  const command = { type: 'contact.upsert', contact: { id: 'customer', name: 'Approved customer', company: '', stage: 'lead', nextAction: '', nextActionDate: null } };
  const input = { generation: 0, revision: 1, commandId: 'scoped-write', command };
  h.grants.set(JSON.stringify({ organizationId: 'one', executorId: 'alice', action: 'records.write', resource: governanceResource('record/contact', 'customer'), commandId: input.commandId,
    generation: 0, revision: 1, commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex') }), { id: 'scoped-grant', approverId: 'bob' });
  const send = () => routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', {
    method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  const response = await send();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['at', 'commandId', 'commandRevision', 'entityId', 'generation', 'revision', 'type']);
  assert.equal(body.entityId, 'customer');
  assert.equal(body.revision, 2);
  assert.deepEqual(await (await send()).json(), body, 'replay retains the same limited response');
  assert.equal(store.snapshot().contacts.length, 2);
  store.execute({ generation: 0, revision: 2, commandId: 'same-id-inventory', command: { type: 'item.upsert', item: {
    id: 'customer', sku: 'SKU-CUSTOMER', name: 'Inventory record with a colliding identifier', stock: 1, reorderAt: 0, supplier: '',
  } } });
  const page = (collection, id) => routes.get('/api/clawmaster/enterprise/query')(new Request(`http://fixture/enterprise/query?${new URLSearchParams({ collection, offset: '0', limit: '1', ...(id ? { id } : {}) })}`, {
    headers: { authorization: 'alice' },
  }));
  for (const [collection, id] of [['contacts', undefined], ['contacts', 'secret'], ['audit', 'customer']]) assert.equal((await page(collection, id)).status, 403);
  const allowed = await page('contacts', 'customer');
  assert.equal(allowed.status, 200);
  assert.equal((await page('inventory', 'customer')).status, 403, 'a contact grant cannot be reused for an inventory row with the same id');
  const selected = await allowed.json();
  assert.equal(selected.total, 1);
  assert.deepEqual(selected.records.map(row => row.id), ['customer']);
  assert.equal(JSON.stringify(selected).includes('Confidential'), false);
  const exec = { agent: { id: 'session-alice' }, callId: 'typed-resource-query', signal: new AbortController().signal };
  const toolPage = await tools.get('enterprise_query').execute({ collection: 'contacts', id: 'customer', offset: 0, limit: 1 }, exec);
  assert.equal(toolPage.records[0].id, 'customer');
  await assert.rejects(tools.get('enterprise_query').execute({ collection: 'inventory', id: 'customer', offset: 0, limit: 1 }, exec), { code: 'permission_denied' });
});

for (const carrier of ['http', 'tool']) test(`${carrier} task writes require authoritative approval bound to exact content and retry without another grant`, async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map(); const tools = new Map();
  let localApprovals = 0; let authorityApprovals = 0;
  const consume = h.authority.consumeApproval;
  h.authority.consumeApproval = request => { authorityApprovals++; return consume(request); };
  const dispose = await mountWatchdogTasks({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => { localApprovals++; return 'allowed-once'; } } }, store, h.access);
  t.after(async () => { await dispose(); store.close(); });
  const input = { id: 'high-risk-task', commandId: 'create-high-risk', revision: 0, command: { type: 'create', task: {
    goal: 'Prepare transfer', scope: 'Approved company account', owner: { kind: 'member', id: 'alice' }, dueAt: null, timezone: 'Asia/Shanghai',
    risk: 'high', checklist: [{ id: 'evidence', description: 'Human checks supporting evidence' }] } } };
  const invoke = async value => {
    if (carrier === 'tool') return tools.get('watchdog_task_command').execute(value, {
      agent: { id: 'session-alice' }, callId: 'task-call', name: 'watchdog_task_command', signal: new AbortController().signal });
    const response = await routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', {
      method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' }, body: JSON.stringify(value) }));
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body;
  };
  const binding = { organizationId: 'one', executorId: 'alice', action: 'task.write', resource: governanceResource('task', input.id), commandId: input.commandId,
    generation: 0, revision: input.revision, commandDigest: createHash('sha256').update(JSON.stringify(input.command)).digest('hex') };
  const caller = await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }));
  await assert.rejects(invoke(input), { code: 'permission_denied' });
  assert.equal(store.tasks.list(caller.identity).tasks.length, 0);
  assert.equal(store.responsibility().records.length, 1);
  assert.equal(store.responsibility().records[0].outcome, 'denied');
  for (const mismatch of [{ resource: 'other-task' }, { revision: 1 }, { commandDigest: 'different-command' }]) {
    h.grants.set(JSON.stringify({ ...binding, ...mismatch }), { id: 'wrong-grant', approverId: 'bob' });
    await assert.rejects(invoke(input), { code: 'permission_denied' });
  }
  h.grants.set(JSON.stringify(binding), { id: 'self-grant', approverId: 'alice' });
  await assert.rejects(invoke(input), { code: 'permission_denied' });
  h.grants.set(JSON.stringify(binding), { id: 'task-grant', approverId: 'bob' });
  const saved = await invoke(input);
  assert.equal(saved.revision, 1);
  assert.equal(saved.risk, 'high');
  const counts = { localApprovals, authorityApprovals };
  assert.deepEqual(await invoke(input), saved);
  assert.deepEqual({ localApprovals, authorityApprovals }, counts);
  assert.equal(store.tasks.history(caller.identity, input.id).tasks.length, 1);
  const history = store.responsibility({ commandId: input.commandId }).records;
  assert.equal(history.length, 6);
  assert.ok(history.slice(0, 5).every(entry => entry.outcome === 'denied' && entry.reasonCode === 'approval_missing'));
  assert.equal(history[5].identity.approval.id, 'task-grant');
  assert.equal(history[5].identity.approval.approverId, 'bob');
  assert.ok(!JSON.stringify(history).includes('Prepare transfer'));
  await assert.rejects(invoke({ ...input, command: { ...input.command, task: { ...input.command.task, goal: 'Different transfer' } } }), { code: 'command_conflict' });
  h.members.set('alice', { active: false, roles: ['executor'], resources: ['*'], policyVersion: 2 });
  await assert.rejects(invoke(input), { code: 'permission_denied' });
});


test('HTTP role and scope refusals append metadata while membership failures omit exception contents', async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { await dispose(); store.close(); });
  for (const [path, operation] of [['', 'records.read'], ['/backup', 'backup.export'], ['/responsibility', 'audit.read']]) {
    const response = await routes.get(`/api/clawmaster/enterprise${path}`)(new Request(`http://fixture/enterprise${path}`, { headers: { authorization: 'alice' } }));
    assert.equal(response.status, 403);
    const entry = store.responsibility().records.at(-1);
    assert.equal(entry.operation, operation);
    assert.equal(entry.outcome, 'denied');
    assert.equal(entry.identity.actor.kind, 'member');
    assert.equal(entry.identity.policyVersion, 1);
  }
  h.authority.membership = async () => { throw new Error('PRIVATE directory response'); };
  assert.equal((await routes.get('/api/clawmaster/enterprise/backup')(new Request('http://fixture/backup', { headers: { authorization: 'alice' } }))).status, 503);
  const entry = store.responsibility().records.at(-1);
  assert.equal(entry.outcome, 'failed');
  assert.equal(entry.reasonCode, 'operation_failed');
  assert.ok(!JSON.stringify(entry).includes('PRIVATE'));
  assert.equal(store.snapshot().revision, 0);
});

for (const outcome of ['rejected', 'cancelled', 'unavailable', 'failure', 'aborted']) test(`task tool ${outcome} approval records one outcome without task contents`, async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const tools = new Map();
  const controller = new AbortController();
  const dispose = await mountWatchdogTasks({ connection: { fetch: { register() { return async () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => {
      if (outcome === 'failure') throw new Error('PRIVATE approval detail');
      if (outcome === 'aborted') { controller.abort(new Error('PRIVATE cancellation reason')); throw controller.signal.reason; }
      return outcome;
    } } }, store, h.access);
  t.after(async () => { await dispose(); store.close(); });
  const input = { id: 'private-task', commandId: 'denied-task', revision: 0, command: { type: 'create', task: {
    goal: 'PRIVATE goal', scope: 'PRIVATE scope', owner: { kind: 'member', id: 'alice' }, dueAt: null, timezone: 'Asia/Shanghai',
    risk: 'high', checklist: [{ id: 'check', description: 'PRIVATE checklist' }] } } };
  const exec = { agent: { id: 'session-alice' }, callId: 'task-call', name: 'watchdog_task_command', signal: controller.signal };
  await assert.rejects(tools.get(exec.name).execute(input, exec));
  const entries = store.responsibility().records;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, 'task.create');
  assert.equal(entries[0].commandId, input.commandId);
  assert.equal(entries[0].identity.actor.kind, 'agent');
  assert.equal(entries[0].identity.principalId, 'alice');
  assert.equal(entries[0].outcome, outcome === 'rejected' ? 'denied' : outcome === 'cancelled' || outcome === 'aborted' ? 'cancelled' : 'failed');
  assert.equal(entries[0].reasonCode, outcome === 'failure' ? 'operation_failed' : outcome === 'aborted' ? 'operation_cancelled' : `approval_${outcome}`);
  assert.ok(!JSON.stringify(entries).includes('PRIVATE'));
  assert.equal(store.tasks.list(entries[0].identity).tasks.length, 0);
  assert.equal(entries[0].revisionBefore, entries[0].revisionAfter);
  assert.equal(entries[0].generationBefore, entries[0].generationAfter);
  await assert.rejects(tools.get(exec.name).execute(input, { ...exec, agent: { id: 'unbound-session' }, signal: new AbortController().signal }), { code: 'permission_denied' });
  assert.equal(store.responsibility().records.length, 1);
});

test('restore approval refusal and read-tool denials retain only authenticated operation metadata', async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map(); const tools = new Map();
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => { throw new Error('Read tools must not request approval'); } } };
  const removeRoutes = await mountEnterpriseRoutes(ctx, store, h.access);
  const removeTools = await applyEnterpriseTools(ctx, store, {}, h.access);
  const removeTasks = await mountWatchdogTasks(ctx, store, h.access);
  t.after(async () => { await removeTasks(); await removeTools(); await removeRoutes(); store.close(); });
  const backup = store.backup();
  const prepared = await (await routes.get('/api/clawmaster/enterprise/backup/prepare')(new Request('http://fixture/prepare', { method: 'POST', headers: { authorization: 'admin', 'content-type': 'application/json' }, body: JSON.stringify(backup) }))).json();
  const response = await routes.get('/api/clawmaster/enterprise/restore')(new Request('http://fixture/restore', { method: 'POST',
    headers: { authorization: 'admin', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedGeneration: 0, expectedRevision: 0, confirm: true, commandId: 'denied-restore', token: prepared.token, backupSha256: prepared.backupSha256 }) }));
  assert.equal(response.status, 403);
  const restored = store.responsibility({ commandId: 'denied-restore' }).records;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].operation, 'backup.restore');
  assert.equal(restored[0].identity.actor.id, 'admin');
  assert.equal(restored[0].reasonCode, 'approval_missing');
  assert.equal(store.snapshot().generation, 0);
  h.members.set('alice', { active: true, roles: ['executor'], resources: [], policyVersion: 2 });
  const exec = { agent: { id: 'session-alice' }, callId: 'denied-query', signal: new AbortController().signal };
  for (const [name, args, operation] of [
    ['enterprise_query', { collection: 'contacts', search: 'PRIVATE search', offset: 0, limit: 1 }, 'records.read'],
    ['watchdog_task_query', { id: 'task-1' }, 'task.read'],
    ['watchdog_task_command', { id: 'task-1', commandId: 'agent-review', revision: 0, command: { type: 'review', decision: 'accept', comment: 'PRIVATE review' } }, 'task.review'],
  ]) {
    await assert.rejects(tools.get(name).execute(args, { ...exec, name }), { code: 'permission_denied' });
    const entry = store.responsibility().records.at(-1);
    assert.equal(entry.operation, operation);
    assert.equal(entry.outcome, 'denied');
    assert.equal(entry.identity.actor.kind, 'agent');
    assert.equal(entry.identity.principalId, 'alice');
    assert.ok(!JSON.stringify(entry).includes('PRIVATE'));
  }
});

for (const deniedBy of ['inactive', 'role', 'resource']) test(`task HTTP callers denied by ${deniedBy} cannot probe another member's status`, async t => {
  const h = authorityFixture();
  h.members.set('alice', { active: deniedBy !== 'inactive', roles: deniedBy === 'role' ? ['auditor'] : ['executor'],
    resources: deniedBy === 'resource' ? ['unrelated-task'] : ['*'], policyVersion: 2 });
  const lookups = [];
  const membership = h.authority.membership;
  h.authority.membership = async (...args) => { lookups.push(args[1]); return membership(...args); };
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map();
  const dispose = await mountWatchdogTasks({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => { throw new Error('No authorized task action'); } } }, store, h.access);
  t.after(async () => { await dispose(); store.close(); });
  const responses = [];
  for (const owner of ['bob', 'unknown-owner']) {
    const input = { id: 'protected-task', commandId: `probe-${owner}`, revision: 0, command: { type: 'create', task: {
      goal: 'Synthetic task', scope: 'Selected records', owner: { kind: 'member', id: owner }, dueAt: null,
      timezone: 'Asia/Shanghai', risk: 'low', checklist: [{ id: 'checked', description: 'Review evidence' }],
    } } };
    const response = await routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', {
      method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    assert.equal(response.status, 403); responses.push(await response.json());
  }
  assert.deepEqual(responses[0], responses[1], 'An unauthorized caller cannot distinguish existing and missing members.');
  assert.deepEqual(lookups, ['alice', 'alice']);
  assert.equal(store.tasks.list((await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }))).identity).tasks.length, 0);
});

for (const carrier of ['http', 'tool']) for (const type of ['create', 'revise']) test(`${carrier} ${type} refuses an owner revoked during independent approval`, async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map(); const tools = new Map();
  const waiting = Promise.withResolvers(); const release = Promise.withResolvers();
  const consume = h.authority.consumeApproval;
  h.authority.consumeApproval = async request => { waiting.resolve(); await release.promise; return consume(request); };
  const dispose = await mountWatchdogTasks({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => 'allowed-once' } }, store, h.access);
  t.after(async () => { release.resolve(); await dispose(); store.close(); });
  const caller = await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }));
  const identity = await caller.check('task.write');
  const definition = { goal: 'Review selected records', scope: 'Synthetic records', owner: { kind: 'member', id: 'audit' },
    dueAt: null, timezone: 'Asia/Shanghai', risk: 'low', checklist: [{ id: 'checked', description: 'Review evidence' }] };
  if (type === 'revise') store.tasks.execute(identity, { id: 'owner-task', commandId: 'seed', revision: 0, command: { type: 'create', task: definition } });
  const revision = type === 'revise' ? 1 : 0;
  const input = { id: 'owner-task', commandId: 'revoked-owner', revision, command: { type, task: { ...definition, goal: 'Changed goal' } } };
  h.grants.set(JSON.stringify({ organizationId: 'one', executorId: 'alice', action: 'task.write', resource: governanceResource('task', input.id),
    commandId: input.commandId, generation: 0, revision, commandDigest: createHash('sha256').update(JSON.stringify(input.command)).digest('hex') }),
  { id: 'independent-grant', approverId: 'bob' });
  const invoke = async () => {
    if (carrier === 'tool') return tools.get('watchdog_task_command').execute(input, {
      agent: { id: 'session-alice' }, callId: 'owner-call', name: 'watchdog_task_command', signal: new AbortController().signal });
    const response = await routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', {
      method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body;
  };
  const rejected = assert.rejects(invoke(), { code: 'permission_denied' });
  await waiting.promise;
  h.members.set('audit', { active: false, roles: ['auditor'], resources: ['*'], policyVersion: 2 });
  release.resolve(); await rejected;
  assert.equal(store.tasks.replay(identity, input), undefined);
  assert.equal(store.tasks.list(identity).tasks.length, revision);
  if (type === 'revise') assert.equal(store.tasks.get(identity, input.id).goal, definition.goal);
  const last = store.responsibility().records.at(-1);
  assert.equal(last.outcome, 'denied'); assert.equal(last.commandId, input.commandId);
});

test('malformed authority responses fail closed as unavailable without local fallback', async t => {
  const h = authorityFixture();
  const store = await openEnterpriseStore(':memory:', 5000, 'one');
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } }, store, h.access);
  t.after(async () => { await dispose(); store.close(); });

  h.authority.http = async () => ({ organizationId: 'one', memberId: 'alice', actor: 'agent' });
  let response = await routes.get('/api/clawmaster/enterprise')(new Request('http://fixture/enterprise'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'storage_unavailable');

  h.authority.http = async () => h.principals.get('alice');
  h.authority.membership = async () => ({ active: 'yes', roles: ['administrator'], policyVersion: 1, resources: ['*'] });
  response = await routes.get('/api/clawmaster/enterprise')(new Request('http://fixture/enterprise', { headers: { authorization: 'alice' } }));
  assert.equal(response.status, 503);

  h.authority.membership = async () => ({ active: true, roles: ['executor'], policyVersion: 1, resources: ['*'] });
  h.authority.consumeApproval = async () => ({ id: 12, approverId: 'bob' });
  const command = { generation: 0, revision: 0, commandId: 'malformed-approval', command: { type: 'contact.upsert', contact: {
    id: 'customer', name: 'Must not save', company: '', stage: 'lead', nextAction: '', nextActionDate: null,
  } } };
  response = await routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/enterprise/command', {
    method: 'POST', headers: { authorization: 'alice', 'content-type': 'application/json' }, body: JSON.stringify(command),
  }));
  assert.equal(response.status, 503);
  assert.equal(store.snapshot().revision, 0);
  assert.equal(JSON.stringify(store.responsibility().records).includes('Must not save'), false);

  h.authority.agent = async () => ({ organizationId: 'one', memberId: 'alice', actor: 'agent' });
  await assert.rejects(h.access.agent('session-alice'), /invalid Session identity response/);
});
