import { describe, expect, it } from 'vitest';

import {
  ChannelPairingCoordinator,
  type ChannelPairingAuditEvent,
} from './channelConnector.js';

function setup(now = 1_000_000): {
  coordinator: ChannelPairingCoordinator;
  events: ChannelPairingAuditEvent[];
  clock: { now: number };
} {
  const events: ChannelPairingAuditEvent[] = [];
  const clock = { now };
  return {
    events,
    clock,
    coordinator: new ChannelPairingCoordinator({
      publicPairingOrigin: 'https://connect.otto.example',
      now: () => clock.now,
      randomToken: () => 'single-use-pairing-nonce-with-enough-entropy',
      audit: (event) => events.push({ ...event }),
    }),
  };
}

describe('ChannelPairingCoordinator', () => {
  it('creates a short-lived QR payload and completes a single-use installation', async () => {
    const { coordinator, events } = setup();
    const pairing = await coordinator.begin({
      provider: 'lark',
      installationPublicKey: 'device-public-key',
      requestedScopes: ['im:message', 'im:message', 'contact:user:read'],
    });

    expect(pairing.status).toBe('waiting_scan');
    expect(pairing.requestedScopes).toEqual(['contact:user:read', 'im:message']);
    expect(pairing.qrPayload).toContain('https://connect.otto.example/channel/pair?');
    expect(pairing.qrPayload).not.toContain('appSecret');

    const authorized = await coordinator.authorize(
      pairing.pairingId,
      'single-use-pairing-nonce-with-enough-entropy',
      {
        tenantId: 'tenant-1', tenantName: 'Acme', botName: 'ClawMaster',
        grantedScopes: ['im:message'],
      },
    );
    expect(authorized.status).toBe('user_authorized');
    expect(authorized.qrPayload).toBe('');

    const installation = await coordinator.complete(pairing.pairingId);
    expect(installation).toMatchObject({
      provider: 'lark', tenantId: 'tenant-1', tenantName: 'Acme', botName: 'ClawMaster',
      grantedScopes: ['im:message'],
    });
    expect((await coordinator.get(pairing.pairingId)).status).toBe('connected');
    await expect(coordinator.authorize(
      pairing.pairingId,
      'single-use-pairing-nonce-with-enough-entropy',
      { tenantId: 'other', tenantName: 'Other', botName: 'Other', grantedScopes: ['im:message'] },
    )).rejects.toThrow('connected');
    expect(events.map((event) => event.to)).toEqual([
      'waiting_scan', 'user_authorized', 'installing', 'verifying', 'connected',
    ]);
  });

  it('requires explicit administrator approval when the provider requests it', async () => {
    const { coordinator } = setup();
    const pairing = await coordinator.begin({
      provider: 'wecom',
      installationPublicKey: 'device-public-key',
      requestedScopes: ['message:send'],
    });
    const waiting = await coordinator.authorize(
      pairing.pairingId,
      'single-use-pairing-nonce-with-enough-entropy',
      {
        tenantId: 'corp-1', tenantName: '企业', botName: 'ClawMaster',
        grantedScopes: ['message:send'], requiresAdminApproval: true,
      },
    );
    expect(waiting.status).toBe('waiting_admin');
    await expect(coordinator.complete(pairing.pairingId)).rejects.toThrow('waiting_admin');
    expect((await coordinator.approveAdmin(pairing.pairingId)).status).toBe('user_authorized');
  });

  it('expires without accepting a late callback and audits the terminal state', async () => {
    const { coordinator, clock, events } = setup();
    const pairing = await coordinator.begin({
      provider: 'feishu',
      installationPublicKey: 'device-public-key',
      requestedScopes: ['im:message'],
    });
    clock.now = pairing.expiresAtMs;
    expect((await coordinator.get(pairing.pairingId)).status).toBe('expired');
    await expect(coordinator.authorize(
      pairing.pairingId,
      'single-use-pairing-nonce-with-enough-entropy',
      { tenantId: 'late', tenantName: 'Late', botName: 'Late', grantedScopes: ['im:message'] },
    )).rejects.toThrow('expired');
    expect(events.at(-1)).toMatchObject({ to: 'expired', reason: 'pairing expired' });
  });

  it('rejects nonce mismatches and scope escalation', async () => {
    const { coordinator } = setup();
    const pairing = await coordinator.begin({
      provider: 'lark',
      installationPublicKey: 'device-public-key',
      requestedScopes: ['im:message'],
    });
    await expect(coordinator.authorize(
      pairing.pairingId,
      'wrong-nonce-with-enough-characters-to-hash',
      { tenantId: 't', tenantName: 'T', botName: 'B', grantedScopes: ['im:message'] },
    )).rejects.toThrow('invalid channel pairing nonce');
    await expect(coordinator.authorize(
      pairing.pairingId,
      'single-use-pairing-nonce-with-enough-entropy',
      { tenantId: 't', tenantName: 'T', botName: 'B', grantedScopes: ['admin:all'] },
    )).rejects.toThrow('unrequested channel scope');
  });
});
