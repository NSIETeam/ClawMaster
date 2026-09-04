/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClawMasterServer } from './server.js';
import { ProductWorkspaceStore } from './productWorkspaceStore.js';
import type {
  ChannelConnectorV1,
  PairingSession,
} from './modules/integration_adapters/channelConnector.js';

const pairing: PairingSession = {
  pairingId: 'pair_0123456789abcdef01234567',
  provider: 'feishu',
  status: 'waiting_scan',
  qrPayload: 'https://pairing.example/channel/pair?opaque=1',
  expiresAtMs: Date.now() + 300_000,
  requestedScopes: ['im:message'],
};

function fakeConnector(): ChannelConnectorV1 {
  return {
    beginPairing: vi.fn(async () => pairing),
    getPairingStatus: vi.fn(async () => pairing),
    approveAdmin: vi.fn(async () => ({ ...pairing, status: 'user_authorized' })),
    denyPairing: vi.fn(async () => ({ ...pairing, status: 'denied' })),
    completeInstallation: vi.fn(async () => ({
      installationId: 'channel_feishu_0123456789abcdef01234567',
      provider: 'feishu',
      tenantId: 'tenant-1',
      tenantName: 'Example tenant',
      botName: 'ClawMaster',
      grantedScopes: ['im:message'],
      connectedAtMs: Date.now(),
    })),
    start: vi.fn(async () => ({ installationId: 'install-1', running: true, state: 'connected', reconnectCount: 0 })),
    stop: vi.fn(async () => ({ installationId: 'install-1', running: false, state: 'stopped', reconnectCount: 0 })),
    revoke: vi.fn(async () => undefined),
    health: vi.fn(async () => ({ installationId: 'install-1', running: true, state: 'connected', reconnectCount: 0 })),
  };
}

describe('channel pairing REST routes', () => {
  let userDir: string;
  let server: ClawMasterServer | undefined;

  beforeEach(() => {
    userDir = mkdtempSync(path.join(tmpdir(), 'otto-channel-pairing-'));
    vi.stubEnv('HOME', userDir);
    vi.stubEnv('USERPROFILE', userDir);
    vi.stubEnv('CLAWMASTER_USER_DIR', userDir);
  });

  afterEach(async () => {
    await server?.stop();
    vi.unstubAllEnvs();
    rmSync(userDir, { recursive: true, force: true });
  });

  async function start(connectors = {}): Promise<{ baseUrl: string; token: string }> {
    server = new ClawMasterServer({
      port: 0,
      mock: true,
      channelConnectors: connectors,
      productWorkspaceStore: new ProductWorkspaceStore(path.join(userDir, 'workspace.json')),
    });
    await server.start();
    const http = (server as unknown as { http: { address(): { port: number } } }).http;
    return {
      baseUrl: `http://127.0.0.1:${http.address().port}`,
      token: server.controlToken,
    };
  }

  it('requires the local control token and reports a missing real connector', async () => {
    const { baseUrl, token } = await start();
    const body = JSON.stringify({
      provider: 'feishu',
      installationPublicKey: 'public-key',
      requestedScopes: ['im:message'],
    });

    expect((await fetch(`${baseUrl}/channels/pairings`, { method: 'POST', body })).status).toBe(401);
    const unavailable = await fetch(`${baseUrl}/channels/pairings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      ok: false,
      error: 'channel_connector_unavailable:feishu',
    });
  });

  it('delegates begin, status, install and cancellation to one provider connector', async () => {
    const connector = fakeConnector();
    const { baseUrl, token } = await start({ feishu: connector });
    const auth = { authorization: `Bearer ${token}` };
    const begun = await fetch(`${baseUrl}/channels/pairings`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'feishu',
        installationPublicKey: 'public-key',
        requestedScopes: ['im:message'],
      }),
    });
    expect(begun.status).toBe(201);
    expect(await begun.json()).toMatchObject({ ok: true, data: { status: 'waiting_scan' } });

    for (const [suffix, method] of [
      ['', 'GET'],
      ['/install', 'POST'],
      ['', 'DELETE'],
    ] as const) {
      const response = await fetch(`${baseUrl}/channels/pairings/${pairing.pairingId}${suffix}`, {
        method,
        headers: auth,
      });
      expect(response.status).toBe(200);
    }
    expect(connector.getPairingStatus).toHaveBeenCalledOnce();
    expect(connector.completeInstallation).toHaveBeenCalledOnce();
    expect(connector.denyPairing).toHaveBeenCalledOnce();

    const installations = await fetch(`${baseUrl}/channels/installations`, { headers: auth });
    expect(installations.status).toBe(200);
    expect(await installations.json()).toMatchObject({
      ok: true,
      data: [{ installationId: 'channel_feishu_0123456789abcdef01234567' }],
    });

    const installationId = 'channel_feishu_0123456789abcdef01234567';
    for (const [suffix, method] of [
      ['/health', 'GET'],
      ['/start', 'POST'],
      ['/stop', 'POST'],
      ['', 'DELETE'],
    ] as const) {
      const response = await fetch(`${baseUrl}/channels/installations/${installationId}${suffix}`, {
        method,
        headers: auth,
      });
      expect(response.status).toBe(200);
    }
    expect(connector.health).toHaveBeenCalledWith(installationId);
    expect(connector.start).toHaveBeenCalledWith(installationId);
    expect(connector.stop).toHaveBeenCalledWith(installationId);
    expect(connector.revoke).toHaveBeenCalledWith(installationId);
  });

  it('restores installed connector routing after the local server restarts', async () => {
    const connector = fakeConnector();
    const first = await start({ feishu: connector });
    const firstAuth = {
      authorization: `Bearer ${first.token}`,
      'content-type': 'application/json',
    };
    await fetch(`${first.baseUrl}/channels/pairings`, {
      method: 'POST',
      headers: firstAuth,
      body: JSON.stringify({
        provider: 'feishu',
        installationPublicKey: 'public-key',
        requestedScopes: ['im:message'],
      }),
    });
    const installed = await fetch(
      `${first.baseUrl}/channels/pairings/${pairing.pairingId}/install`,
      { method: 'POST', headers: firstAuth },
    );
    expect(installed.status).toBe(200);

    await server?.stop();
    server = undefined;

    const second = await start({ feishu: connector });
    const secondAuth = { authorization: `Bearer ${second.token}` };
    const installations = await fetch(`${second.baseUrl}/channels/installations`, {
      headers: secondAuth,
    });
    expect(await installations.json()).toMatchObject({
      ok: true,
      data: [{
        installationId: 'channel_feishu_0123456789abcdef01234567',
        tenantId: 'tenant-1',
      }],
    });

    const health = await fetch(
      `${second.baseUrl}/channels/installations/channel_feishu_0123456789abcdef01234567/health`,
      { headers: secondAuth },
    );
    expect(health.status).toBe(200);
    expect(connector.health).toHaveBeenCalledWith(
      'channel_feishu_0123456789abcdef01234567',
    );
  });
});
