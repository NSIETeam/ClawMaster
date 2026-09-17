import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceAccess } from '../src/governance-access.ts';
import { openEnterpriseStore, mountEnterpriseRoutes } from '../src/enterprise-host.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';

function accessFor(organizationId) {
  return new GovernanceAccess({ mode: 'enterprise', organizationId, authority: {
    async http(request) {
      const subject = request.headers.get('authorization');
      if (!['org-a-member', 'org-b-member'].includes(subject)) return undefined;
      return { organizationId: subject.slice(0, 5), memberId: 'operator', actor: 'human' };
    },
    async agent(sessionId) {
      if (!['org-a-session', 'org-b-session'].includes(sessionId)) return undefined;
      return { organizationId: sessionId.slice(0, 5), memberId: 'operator', actor: 'agent', sessionId };
    },
    async membership(org, member) { return org === organizationId && member === 'operator'
      ? { active: true, roles: ['administrator'], resources: ['*'], policyVersion: 1 } : undefined; },
    async consumeApproval() { return undefined; },
  } });
}

async function fixture(t, organizationId) {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-tenant-isolation-'));
  const store = await openEnterpriseStore(join(directory, 'enterprise.sqlite'), 5000, organizationId);
  const routes = new Map(); const tools = new Map();
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, approval: { request: async () => 'allowed-once' } };
  const access = accessFor(organizationId); const dispose = [];
  dispose.push(await mountEnterpriseRoutes(ctx, store, access));
  dispose.push(await applyEnterpriseTools(ctx, store, {}, access));
  store.execute({ generation: 0, revision: 0, commandId: `seed-${organizationId}`, command: { type: 'contact.upsert', contact: {
    id: 'shared-id', name: `Owned by ${organizationId}`, company: '', stage: 'lead', nextAction: '', nextActionDate: null,
  } } });
  t.after(async () => { for (const remove of dispose.reverse()) await remove(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, routes, tools };
}

test('two organization authorities reject cross-organization HTTP, tool, write and export requests', async t => {
  const a = await fixture(t, 'org-a'); const b = await fixture(t, 'org-b');
  const query = '/api/clawmaster/enterprise/query?collection=contacts&id=shared-id&offset=0&limit=10';
  const request = (h, path, member) => h.routes.get(new URL(path, 'http://fixture').pathname)(new Request(`http://fixture${path}`, { headers: { authorization: member } }));
  assert.equal((await request(a, query, 'org-a-member')).status, 200);
  assert.equal((await request(a, query, 'org-b-member')).status, 403);
  assert.equal((await request(b, query, 'org-a-member')).status, 403);
  assert.equal((await request(a, '/api/clawmaster/enterprise/backup', 'org-b-member')).status, 403);
  const foreignTool = a.tools.get('enterprise_query').execute({ collection: 'contacts', id: 'shared-id', offset: 0, limit: 10 }, {
    agent: { id: 'org-b-session' }, callId: 'foreign-query', signal: new AbortController().signal,
  });
  await assert.rejects(foreignTool, { code: 'permission_denied' });
  const write = await a.routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/api/clawmaster/enterprise/command', {
    method: 'POST', headers: { authorization: 'org-b-member', 'content-type': 'application/json' },
    body: JSON.stringify({ generation: 0, revision: 1, commandId: 'foreign-write', command: { type: 'contact.upsert', contact: {
      id: 'shared-id', name: 'Cross-tenant overwrite', company: '', stage: 'lead', nextAction: '', nextActionDate: null,
    } } }),
  }));
  assert.equal(write.status, 403);
  assert.equal(a.store.snapshot().contacts[0].name, 'Owned by org-a');
  assert.equal(a.store.snapshot().revision, 1);
  assert.equal(a.store.responsibility().records.length, 1, 'the failed cross-organization caller adds no target-organization audit row');
});
