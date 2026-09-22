/** Component health is a local-desktop fact: the route serves it there and refuses it on a shared Host. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GovernanceAccess } from '../src/governance-access.ts';
import { mountRuntimeHealth } from '../src/runtime-health-host.ts';

/** One Host runtime observation as `observeRuntime` returns it, so this test reads no state file. */
function observation(overrides = {}) {
  return { available: true, observedAt: '2026-09-22T00:00:00.000Z', reason: null,
    identity: { startedAtUnixMs: 1_800_000_000_000, desktopVersion: '0.2.3', harnessVersion: '0.1.5-rc.2',
      contentSha256: 'a'.repeat(64), hostPid: 4, port: 17890, source: { gitCommit: 'c', gitTree: 't', dirty: false, sourceSha256: 's', mode: 'release' },
      disabledPlugins: ['@clawmaster/dsh-office'],
      inventory: { components: [{ name: '@clawmaster/dsh-guard', version: '0.1.0', manifestSha256: 'b'.repeat(64), artifactCount: 1, artifactsSha256: 'c'.repeat(64) }], patches: [] } },
    ...overrides };
}

/** A route registry that keeps whatever the consumer registered. */
function registry() {
  const routes = new Map();
  return { routes, connection: { fetch: { register: route => { routes.set(route.path, route); return async () => routes.delete(route.path); } } } };
}

/** An enterprise access object whose authority functions exist but are never reached by this route. */
function enterprise() {
  const refuse = async () => { throw new Error('The authority must not be consulted for component health.'); };
  return new GovernanceAccess({ mode: 'enterprise', organizationId: 'acme', authority: { http: refuse, agent: refuse, membership: refuse, consumeApproval: refuse } });
}


test('serves the local Host its own component health without paths or digests', async () => {
  const fake = registry();
  await mountRuntimeHealth(fake, new GovernanceAccess(), () => observation());
  const response = await fake.routes.get('/api/clawmaster/runtime').fetch(new Request('http://localhost/api/clawmaster/runtime'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.mode, 'release');
  assert.equal(body.components, 1);
  assert.deepEqual(body.disabledPlugins, ['@clawmaster/dsh-office']);
  const text = JSON.stringify(body);
  for (const undisclosed of ['/harness', 'sha256', 'harnessRoot', 'contentSha256']) assert.ok(!text.includes(undisclosed), `response must not disclose ${undisclosed}`);
});

test('reports an unobserved Host instead of inventing component health', async () => {
  const fake = registry();
  await mountRuntimeHealth(fake, new GovernanceAccess(), () => ({ available: false, observedAt: '2026-09-22T00:00:00.000Z', reason: 'desktop-state-not-configured', identity: null }));
  const response = await fake.routes.get('/api/clawmaster/runtime').fetch(new Request('http://localhost/api/clawmaster/runtime'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.components, null);
  assert.equal(body.disabledPlugins.length, 0);
  assert.ok(typeof body.reason === 'string' && body.reason !== '');
});

test('refuses a shared Host without consulting its identity authority', async () => {
  const fake = registry();
  await mountRuntimeHealth(fake, enterprise(), () => observation());
  const response = await fake.routes.get('/api/clawmaster/runtime').fetch(new Request('http://localhost/api/clawmaster/runtime'));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'permission_denied');
  assert.ok(!('components' in body));
});

test('refuses a query and unregisters on disposal', async () => {
  const fake = registry();
  const remove = await mountRuntimeHealth(fake, new GovernanceAccess(), () => observation());
  const route = fake.routes.get('/api/clawmaster/runtime');
  assert.equal((await route.fetch(new Request('http://localhost/api/clawmaster/runtime?limit=1'))).status, 400);
  assert.deepEqual(route.methods, ['GET']);
  await remove();
  assert.equal(fake.routes.size, 0);
});
