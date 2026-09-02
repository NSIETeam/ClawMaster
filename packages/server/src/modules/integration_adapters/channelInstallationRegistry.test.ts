import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileChannelInstallationRegistry,
} from './channelInstallationRegistry.js';
import type { ChannelInstallation } from './channelConnector.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installation(overrides: Partial<ChannelInstallation> = {}): ChannelInstallation {
  return {
    installationId: 'channel_feishu_0123456789abcdef01234567',
    provider: 'feishu',
    tenantId: 'tenant-1',
    tenantName: 'Example tenant',
    botName: 'ClawMaster',
    grantedScopes: ['im:message'],
    connectedAtMs: 1_000,
    ...overrides,
  };
}

function registryPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'clawmaster-channel-registry-'));
  roots.push(root);
  return path.join(root, 'channel-installations.json');
}

describe('FileChannelInstallationRegistry', () => {
  it('persists public installation metadata and restores it after restart', () => {
    const file = registryPath();
    new FileChannelInstallationRegistry(file).upsert(installation());

    const restored = new FileChannelInstallationRegistry(file);
    expect(restored.list()).toEqual([installation()]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/secret|token|privateKey/i);
  });

  it('updates atomically without duplicating an installation', () => {
    const file = registryPath();
    const registry = new FileChannelInstallationRegistry(file);
    registry.upsert(installation());
    registry.upsert(installation({ botName: 'ClawMaster Enterprise' }));

    expect(registry.list()).toHaveLength(1);
    expect(registry.get(installation().installationId)?.botName).toBe('ClawMaster Enterprise');
    expect(registry.remove(installation().installationId)).toBe(true);
    expect(new FileChannelInstallationRegistry(file).list()).toEqual([]);
  });

  it('rejects provider or tenant takeover of an existing installation id', () => {
    const registry = new FileChannelInstallationRegistry(registryPath());
    registry.upsert(installation());

    expect(() => registry.upsert(installation({ provider: 'lark' }))).toThrow('provider');
    expect(() => registry.upsert(installation({ tenantId: 'tenant-2' }))).toThrow('tenant');
  });

  it('fails closed on a damaged registry without overwriting evidence', () => {
    const file = registryPath();
    writeFileSync(file, '{broken', 'utf8');

    expect(new FileChannelInstallationRegistry(file).list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
});
