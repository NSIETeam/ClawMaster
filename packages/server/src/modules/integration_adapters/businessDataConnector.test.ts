import { describe, expect, it, vi } from 'vitest';
import { createCanonicalEvent } from '../company_os/index.js';
import {
  BusinessDataConnectorCoordinator,
  OWL_PRICING_CONNECTOR_DESCRIPTOR,
  ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR,
  createFixtureBusinessDataConnector,
  type BusinessDataConnectorV1,
} from './businessDataConnector.js';

const configuration = {
  organizationId: 'org-1',
  connectorId: 'owl-pricing-v1',
  endpoint: 'https://owl.example/api',
  secretRef: 'secret://org-1/owl',
  enabled: true,
};

function productionConnector(): BusinessDataConnectorV1 {
  return {
    descriptor: {
      ...OWL_PRICING_CONNECTOR_DESCRIPTOR,
      rateLimit: { maxBatchSize: 100, minIntervalMs: 1_000 },
    },
    readiness: vi.fn(async () => ({ state: 'ready', message: 'connected' })),
    sync: vi.fn(async (input) => ({
      events: [createCanonicalEvent({
        organizationId: input.organizationId, type: 'owl.price.anomaly',
        payload: { skuId: 'sku-1' }, source: 'owl', sourceRevision: 'r1',
        observedAt: '2026-09-06T04:00:00.000Z', correlationId: 'sync-1',
        idempotencyKey: 'owl-price-1',
      })],
      nextCursor: 'cursor-2', hasMore: false,
    })),
  };
}

describe('business data Connector Framework', () => {
  it('blocks insecure endpoints before probing the connector', async () => {
    const connector = productionConnector();
    const coordinator = new BusinessDataConnectorCoordinator({
      connectors: [connector], secretRefs: { exists: vi.fn(async () => true) },
      publish: vi.fn(async () => undefined),
    });
    await expect(coordinator.readiness({
      ...configuration, endpoint: 'http://8.141.8.31',
    })).resolves.toMatchObject({ state: 'blocked', reason: 'insecure_endpoint' });
    expect(connector.readiness).not.toHaveBeenCalled();
  });

  it('requires an opaque available secretRef without exposing its value', async () => {
    const connector = productionConnector();
    const exists = vi.fn(async () => false);
    const coordinator = new BusinessDataConnectorCoordinator({
      connectors: [connector], secretRefs: { exists },
      publish: vi.fn(async () => undefined),
    });
    const missing = await coordinator.readiness({ ...configuration, secretRef: undefined });
    const unavailable = await coordinator.readiness(configuration);
    expect(missing).toMatchObject({ state: 'blocked', reason: 'secret_ref_missing' });
    expect(unavailable).toMatchObject({ state: 'blocked', reason: 'secret_unavailable' });
    expect(exists).toHaveBeenCalledWith('secret://org-1/owl');
    expect(JSON.stringify([missing, unavailable])).not.toContain('secret://org-1/owl');
  });

  it('redacts connector secrets and endpoints from readiness messages', async () => {
    const connector = productionConnector();
    vi.mocked(connector.readiness).mockResolvedValue({
      state: 'degraded',
      message: 'failed secret://org-1/owl at https://owl.example/api Bearer token-value',
    });
    const coordinator = new BusinessDataConnectorCoordinator({
      connectors: [connector], secretRefs: { exists: vi.fn(async () => true) },
      publish: vi.fn(async () => undefined),
    });
    const readiness = await coordinator.readiness(configuration);
    expect(readiness.state).toBe('degraded');
    expect(JSON.stringify(readiness)).not.toMatch(/secret:\/\/|owl\.example|token-value/u);
  });

  it('publishes a production batch with its durable synchronization cursor', async () => {
    const connector = productionConnector();
    const publish = vi.fn(async () => undefined);
    const coordinator = new BusinessDataConnectorCoordinator({
      connectors: [connector], secretRefs: { exists: vi.fn(async () => true) },
      publish,
    });
    await expect(coordinator.sync(configuration, { cursor: 'cursor-1', limit: 50 }))
      .resolves.toEqual({ published: 1, nextCursor: 'cursor-2', hasMore: false });
    expect(connector.sync).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', cursor: 'cursor-1', limit: 50,
      endpoint: 'https://owl.example/api', secretRef: 'secret://org-1/owl',
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', type: 'owl.price.anomaly',
    }));
  });

  it('never treats fixture data as production without an explicit test override', async () => {
    const fixture = createFixtureBusinessDataConnector({
      descriptor: {
        ...ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR,
        runtime: 'fixture',
        rateLimit: { maxBatchSize: 100, minIntervalMs: 0 },
      },
      events: [createCanonicalEvent({
        organizationId: 'fixture-template', type: 'zhilemon.gmv.anomaly',
        payload: { deltaBps: -1200 }, source: 'zhilemon-fixture',
        sourceRevision: 'fixture-r1', observedAt: '2026-09-06T04:00:00.000Z',
        correlationId: 'fixture-sync', idempotencyKey: 'gmv-1',
      })],
    });
    const publish = vi.fn(async () => undefined);
    const coordinator = new BusinessDataConnectorCoordinator({
      connectors: [fixture], secretRefs: { exists: vi.fn(async () => true) }, publish,
    });
    const fixtureConfig = {
      ...configuration, connectorId: 'zhilemon-commerce-v1',
      endpoint: 'https://fixture.invalid/api', secretRef: 'secret://fixture-only',
    };
    await expect(coordinator.readiness(fixtureConfig)).resolves
      .toMatchObject({ state: 'fixture_only' });
    await expect(coordinator.sync(fixtureConfig, {})).rejects
      .toThrow('connector_fixture_not_allowed');
    await expect(coordinator.sync(fixtureConfig, { allowFixture: true })).resolves
      .toMatchObject({ published: 1 });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', type: 'zhilemon.gmv.anomaly',
    }));
  });

  it('advances fixture cursors instead of replaying the first page', async () => {
    const firstEvent = createCanonicalEvent({
      organizationId: 'fixture-template', type: 'zhilemon.gmv.anomaly',
      payload: { deltaBps: -500 }, source: 'zhilemon-fixture',
      sourceRevision: 'fixture-r1', observedAt: '2026-09-06T04:00:00.000Z',
      correlationId: 'fixture-page', idempotencyKey: 'gmv-1',
    });
    const secondEvent = {
      ...firstEvent, id: 'fixture-template:gmv-2', idempotencyKey: 'gmv-2',
    };
    const fixture = createFixtureBusinessDataConnector({
      descriptor: {
        ...ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR,
        runtime: 'fixture',
        rateLimit: { maxBatchSize: 1, minIntervalMs: 0 },
      },
      events: [firstEvent, secondEvent],
    });
    const published: string[] = [];
    const coordinator = new BusinessDataConnectorCoordinator({
      connectors: [fixture], secretRefs: { exists: vi.fn(async () => true) },
      publish: (item) => { published.push(item.id); },
    });
    const config = {
      ...configuration, connectorId: 'zhilemon-commerce-v1',
      endpoint: 'https://fixture.invalid/api',
    };
    const first = await coordinator.sync(config, { limit: 1, allowFixture: true });
    expect(first).toEqual({ published: 1, nextCursor: 'fixture:1', hasMore: true });
    await expect(coordinator.sync(config, {
      cursor: first.nextCursor, limit: 1, allowFixture: true,
    })).resolves.toEqual({ published: 1, nextCursor: null, hasMore: false });
    expect(published).toEqual([firstEvent.id, secondEvent.id]);
  });
});
