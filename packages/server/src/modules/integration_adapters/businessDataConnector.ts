/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import type { CanonicalEvent } from '../company_os/index.js';

export interface BusinessDataConnectorDescriptor {
  id: string;
  provider: string;
  version: string;
  canonicalSchemaVersion: number;
  runtime: 'production' | 'fixture';
  capabilities: readonly string[];
  conflictPolicy: 'source_revision_wins' | 'reject_conflict';
  rateLimit: { maxBatchSize: number; minIntervalMs: number };
}

export interface BusinessDataConnectorConfiguration {
  organizationId: string;
  connectorId: string;
  endpoint?: string | undefined;
  secretRef?: string | undefined;
  enabled: boolean;
}

export type BusinessDataConnectorReadinessState =
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'unavailable'
  | 'fixture_only';

export interface BusinessDataConnectorReadiness {
  connectorId: string;
  provider: string;
  canonicalSchemaVersion: number;
  capabilities: readonly string[];
  state: BusinessDataConnectorReadinessState;
  reason?: string;
  message?: string;
}

export interface BusinessDataConnectorSyncInput {
  organizationId: string;
  endpoint: string;
  secretRef: string;
  cursor: string | null;
  limit: number;
}

export interface BusinessDataConnectorSyncBatch {
  events: readonly CanonicalEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface BusinessDataConnectorV1 {
  readonly descriptor: BusinessDataConnectorDescriptor;
  readiness(input: {
    organizationId: string;
    endpoint: string;
    secretRef: string;
  }): Promise<{ state: 'ready' | 'degraded'; message?: string }>;
  sync(input: BusinessDataConnectorSyncInput): Promise<BusinessDataConnectorSyncBatch>;
}

export interface BusinessDataSecretReferenceProvider {
  exists(secretRef: string): Promise<boolean>;
}

export const OWL_PRICING_CONNECTOR_DESCRIPTOR: BusinessDataConnectorDescriptor = {
  id: 'owl-pricing-v1',
  provider: 'owl',
  version: '1.0.0',
  canonicalSchemaVersion: 1,
  runtime: 'production',
  capabilities: ['pricing.anomalies.read'],
  conflictPolicy: 'source_revision_wins',
  rateLimit: { maxBatchSize: 500, minIntervalMs: 60_000 },
};

export const ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR: BusinessDataConnectorDescriptor = {
  id: 'zhilemon-commerce-v1',
  provider: 'zhilemon',
  version: '1.0.0',
  canonicalSchemaVersion: 1,
  runtime: 'production',
  capabilities: ['commerce.performance.read', 'commerce.refunds.read'],
  conflictPolicy: 'source_revision_wins',
  rateLimit: { maxBatchSize: 500, minIntervalMs: 60_000 },
};

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function endpoint(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
}

function validateDescriptor(descriptor: BusinessDataConnectorDescriptor): void {
  identifier(descriptor.id, 'connector_id');
  identifier(descriptor.provider, 'connector_provider');
  if (!/^\d+\.\d+\.\d+$/u.test(descriptor.version)) {
    throw new Error('invalid_connector_version');
  }
  if (!Number.isSafeInteger(descriptor.canonicalSchemaVersion)
    || descriptor.canonicalSchemaVersion < 1) {
    throw new Error('invalid_canonical_schema_version');
  }
  if (!descriptor.capabilities.length
    || descriptor.capabilities.some((capability) => !capability.trim())) {
    throw new Error('invalid_connector_capabilities');
  }
  if (!Number.isSafeInteger(descriptor.rateLimit.maxBatchSize)
    || descriptor.rateLimit.maxBatchSize < 1
    || descriptor.rateLimit.maxBatchSize > 10_000
    || !Number.isSafeInteger(descriptor.rateLimit.minIntervalMs)
    || descriptor.rateLimit.minIntervalMs < 0) {
    throw new Error('invalid_connector_rate_limit');
  }
}

function safeMessage(message: string, secretRef: string, endpointValue: string): string {
  return message
    .replaceAll(secretRef, '[REDACTED]')
    .replaceAll(endpointValue, '[REDACTED]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .slice(0, 500);
}

export class BusinessDataConnectorCoordinator {
  private readonly connectors = new Map<string, BusinessDataConnectorV1>();

  constructor(private readonly options: {
    connectors: readonly BusinessDataConnectorV1[];
    secretRefs: BusinessDataSecretReferenceProvider;
    publish(event: CanonicalEvent): void | Promise<void>;
  }) {
    for (const connector of options.connectors) {
      validateDescriptor(connector.descriptor);
      if (this.connectors.has(connector.descriptor.id)) {
        throw new Error('duplicate_connector_id');
      }
      this.connectors.set(connector.descriptor.id, connector);
    }
  }

  async readiness(
    configuration: BusinessDataConnectorConfiguration,
  ): Promise<BusinessDataConnectorReadiness> {
    const connectorId = identifier(configuration.connectorId, 'connector_id');
    const connector = this.connectors.get(connectorId);
    const base = {
      connectorId,
      provider: connector?.descriptor.provider ?? 'unknown',
      canonicalSchemaVersion: connector?.descriptor.canonicalSchemaVersion ?? 0,
      capabilities: connector?.descriptor.capabilities ?? [],
    };
    if (!connector) return { ...base, state: 'unavailable', reason: 'connector_not_installed' };
    identifier(configuration.organizationId, 'organization_id');
    if (!configuration.enabled) return { ...base, state: 'blocked', reason: 'connector_disabled' };
    const normalizedEndpoint = endpoint(configuration.endpoint);
    if (!normalizedEndpoint) {
      return {
        ...base, state: 'blocked',
        reason: configuration.endpoint ? 'insecure_endpoint' : 'endpoint_missing',
      };
    }
    const secretRef = configuration.secretRef?.trim();
    if (!secretRef) return { ...base, state: 'blocked', reason: 'secret_ref_missing' };
    if (secretRef.length > 512 || /\s/u.test(secretRef)) {
      return { ...base, state: 'blocked', reason: 'secret_ref_invalid' };
    }
    if (!(await this.options.secretRefs.exists(secretRef))) {
      return { ...base, state: 'blocked', reason: 'secret_unavailable' };
    }
    if (connector.descriptor.runtime === 'fixture') {
      return { ...base, state: 'fixture_only', reason: 'fixture_not_production' };
    }
    try {
      const checked = await connector.readiness({
        organizationId: configuration.organizationId,
        endpoint: normalizedEndpoint,
        secretRef,
      });
      return {
        ...base,
        state: checked.state,
        ...(checked.message
          ? { message: safeMessage(checked.message, secretRef, normalizedEndpoint) }
          : {}),
      };
    } catch {
      return { ...base, state: 'unavailable', reason: 'provider_probe_failed' };
    }
  }

  async sync(
    configuration: BusinessDataConnectorConfiguration,
    options: { cursor?: string | null; limit?: number; allowFixture?: boolean },
  ): Promise<{ published: number; nextCursor: string | null; hasMore: boolean }> {
    const connector = this.connectors.get(configuration.connectorId);
    if (!connector) throw new Error('connector_not_installed');
    const readiness = await this.readiness(configuration);
    if (readiness.state === 'fixture_only' && !options.allowFixture) {
      throw new Error('connector_fixture_not_allowed');
    }
    if (readiness.state !== 'ready' && readiness.state !== 'degraded'
      && readiness.state !== 'fixture_only') {
      throw new Error(`connector_${readiness.reason ?? readiness.state}`);
    }
    const limit = options.limit ?? connector.descriptor.rateLimit.maxBatchSize;
    if (!Number.isSafeInteger(limit) || limit < 1
      || limit > connector.descriptor.rateLimit.maxBatchSize) {
      throw new Error('connector_sync_limit_invalid');
    }
    const cursor = options.cursor ?? null;
    if (cursor !== null && (!cursor.trim() || cursor.length > 1_024)) {
      throw new Error('connector_sync_cursor_invalid');
    }
    const normalizedEndpoint = endpoint(configuration.endpoint)!;
    const secretRef = configuration.secretRef!.trim();
    const batch = await connector.sync({
      organizationId: configuration.organizationId,
      endpoint: normalizedEndpoint,
      secretRef,
      cursor,
      limit,
    });
    if (batch.events.length > limit) throw new Error('connector_sync_batch_too_large');
    if (batch.nextCursor !== null
      && (!batch.nextCursor.trim() || batch.nextCursor.length > 1_024)) {
      throw new Error('connector_sync_cursor_invalid');
    }
    for (const event of batch.events) {
      if (event.organizationId !== configuration.organizationId) {
        throw new Error('connector_event_tenant_mismatch');
      }
      await this.options.publish(event);
    }
    return {
      published: batch.events.length,
      nextCursor: batch.nextCursor,
      hasMore: batch.hasMore,
    };
  }
}

export function createFixtureBusinessDataConnector(input: {
  descriptor: BusinessDataConnectorDescriptor & { runtime: 'fixture' };
  events: readonly CanonicalEvent[];
}): BusinessDataConnectorV1 {
  return {
    descriptor: input.descriptor,
    async readiness() {
      return { state: 'degraded', message: 'fixture only' };
    },
    async sync(syncInput) {
      const offset = syncInput.cursor === null
        ? 0
        : /^fixture:(\d+)$/u.exec(syncInput.cursor)?.[1];
      if (offset === undefined) throw new Error('connector_sync_cursor_invalid');
      const start = Number(offset);
      if (!Number.isSafeInteger(start) || start < 0 || start > input.events.length) {
        throw new Error('connector_sync_cursor_invalid');
      }
      const end = Math.min(input.events.length, start + syncInput.limit);
      return {
        events: input.events.slice(start, end).map((event) => ({
          ...event,
          organizationId: syncInput.organizationId,
        })),
        nextCursor: end < input.events.length ? `fixture:${end}` : null,
        hasMore: end < input.events.length,
      };
    },
  };
}
