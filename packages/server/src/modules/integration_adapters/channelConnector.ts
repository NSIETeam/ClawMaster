/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 *
 * Provider-neutral, QR-first channel installation contract. This module owns
 * pairing lifecycle only; provider SDKs, credentials, and message gateways
 * stay in their individual integration adapters.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ChannelProvider = 'feishu' | 'lark' | 'wecom';
export type PairingStatus =
  | 'waiting_scan'
  | 'user_authorized'
  | 'waiting_admin'
  | 'installing'
  | 'verifying'
  | 'connected'
  | 'expired'
  | 'denied'
  | 'failed'
  | 'revoked';

export interface BeginPairingInput {
  provider: ChannelProvider;
  installationPublicKey: string;
  requestedScopes: readonly string[];
}

export interface PairingSession {
  pairingId: string;
  provider: ChannelProvider;
  status: PairingStatus;
  qrPayload: string;
  expiresAtMs: number;
  requestedScopes: readonly string[];
  tenantName?: string;
  failureReason?: string;
}

export interface ChannelInstallation {
  installationId: string;
  provider: ChannelProvider;
  tenantId: string;
  tenantName: string;
  botName: string;
  grantedScopes: readonly string[];
  connectedAtMs: number;
}

export interface ChannelHealth {
  installationId: string;
  running: boolean;
  state: 'connected' | 'reconnecting' | 'stopped' | 'revoked' | 'failed';
  lastReceivedAtMs?: number;
  lastSentAtMs?: number;
  reconnectCount: number;
  message?: string;
}

export interface ChannelConnectorV1 {
  beginPairing(input: BeginPairingInput): Promise<PairingSession>;
  getPairingStatus(pairingId: string): Promise<PairingSession>;
  denyPairing(pairingId: string, reason?: string): Promise<PairingSession>;
  completeInstallation(pairingId: string): Promise<ChannelInstallation>;
  start(installationId: string): Promise<ChannelHealth>;
  stop(installationId: string): Promise<ChannelHealth>;
  revoke(installationId: string): Promise<void>;
  health(installationId: string): Promise<ChannelHealth>;
}

export interface PairingAuthorization {
  tenantId: string;
  tenantName: string;
  botName: string;
  grantedScopes: readonly string[];
  requiresAdminApproval?: boolean;
}

export type ChannelPairingAuditEvent = {
  pairingId: string;
  provider: ChannelProvider;
  from: PairingStatus | 'created';
  to: PairingStatus;
  occurredAtMs: number;
  reason?: string;
};

interface StoredPairing {
  pairingId: string;
  provider: ChannelProvider;
  status: PairingStatus;
  tokenHash: Buffer;
  installationKeyHash: string;
  requestedScopes: string[];
  expiresAtMs: number;
  authorization?: PairingAuthorization;
  installation?: ChannelInstallation;
  failureReason?: string;
}

export interface ChannelPairingCoordinatorOptions {
  publicPairingOrigin: string;
  audit: (event: Readonly<ChannelPairingAuditEvent>) => void | Promise<void>;
  now?: () => number;
  randomToken?: () => string;
  ttlMs?: number;
}

const PAIRING_ID_PATTERN = /^pair_[a-f0-9]{24}$/;
const DEFAULT_TTL_MS = 5 * 60_000;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('channel pairing origin must use HTTPS');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function validateScopes(scopes: readonly string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('at least one channel scope is required');
  if (normalized.length > 50 || normalized.some((scope) => scope.length > 100)) {
    throw new Error('channel scope request is too large');
  }
  return normalized.sort();
}

/**
 * Coordinates single-use pairing without ever storing the bearer token in
 * plaintext. Provider callbacks must present both the pairing id and nonce.
 */
export class ChannelPairingCoordinator {
  private readonly pairings = new Map<string, StoredPairing>();
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly ttlMs: number;
  private readonly publicPairingOrigin: string;

  constructor(private readonly options: ChannelPairingCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.ttlMs < 30_000 || this.ttlMs > 15 * 60_000) {
      throw new Error('channel pairing TTL must be between 30 seconds and 15 minutes');
    }
    this.publicPairingOrigin = normalizeOrigin(options.publicPairingOrigin);
  }

  async begin(input: BeginPairingInput): Promise<PairingSession> {
    if (!input.installationPublicKey.trim()) {
      throw new Error('installation public key is required');
    }
    const requestedScopes = validateScopes(input.requestedScopes);
    const pairingId = `pair_${randomBytes(12).toString('hex')}`;
    const nonce = this.randomToken();
    if (nonce.length < 32) throw new Error('pairing nonce is too short');
    const pairing: StoredPairing = {
      pairingId,
      provider: input.provider,
      status: 'waiting_scan',
      tokenHash: digest(nonce),
      installationKeyHash: digest(input.installationPublicKey.trim()).toString('hex'),
      requestedScopes,
      expiresAtMs: this.now() + this.ttlMs,
    };
    this.pairings.set(pairingId, pairing);
    await this.emit(pairing, 'created', 'waiting_scan');
    return this.toPublic(pairing, nonce);
  }

  async get(pairingId: string): Promise<PairingSession> {
    const pairing = this.requirePairing(pairingId);
    await this.expireIfNeeded(pairing);
    return this.toPublic(pairing);
  }

  async authorize(
    pairingId: string,
    nonce: string,
    authorization: PairingAuthorization,
  ): Promise<PairingSession> {
    const pairing = this.requirePairing(pairingId);
    await this.expireIfNeeded(pairing);
    this.assertStatus(pairing, 'waiting_scan');
    const candidateHash = digest(nonce);
    if (!timingSafeEqual(pairing.tokenHash, candidateHash)) {
      throw new Error('invalid channel pairing nonce');
    }
    const granted = validateScopes(authorization.grantedScopes);
    if (granted.some((scope) => !pairing.requestedScopes.includes(scope))) {
      throw new Error('provider granted an unrequested channel scope');
    }
    pairing.authorization = { ...authorization, grantedScopes: granted };
    const next = authorization.requiresAdminApproval ? 'waiting_admin' : 'user_authorized';
    await this.transition(pairing, next);
    return this.toPublic(pairing);
  }

  async approveAdmin(pairingId: string): Promise<PairingSession> {
    const pairing = this.requirePairing(pairingId);
    await this.expireIfNeeded(pairing);
    this.assertStatus(pairing, 'waiting_admin');
    await this.transition(pairing, 'user_authorized');
    return this.toPublic(pairing);
  }

  async complete(pairingId: string): Promise<ChannelInstallation> {
    const pairing = this.requirePairing(pairingId);
    await this.expireIfNeeded(pairing);
    this.assertStatus(pairing, 'user_authorized');
    const authorization = pairing.authorization;
    if (!authorization) throw new Error('channel pairing authorization is missing');
    await this.transition(pairing, 'installing');
    await this.transition(pairing, 'verifying');
    const installation: ChannelInstallation = {
      installationId: `channel_${pairing.provider}_${pairing.pairingId.slice(5)}`,
      provider: pairing.provider,
      tenantId: authorization.tenantId,
      tenantName: authorization.tenantName,
      botName: authorization.botName,
      grantedScopes: [...authorization.grantedScopes],
      connectedAtMs: this.now(),
    };
    pairing.installation = installation;
    // The bearer is single use. Erase even its hash after installation.
    pairing.tokenHash.fill(0);
    await this.transition(pairing, 'connected');
    return { ...installation, grantedScopes: [...installation.grantedScopes] };
  }

  async deny(pairingId: string, reason = 'authorization denied'): Promise<PairingSession> {
    const pairing = this.requirePairing(pairingId);
    await this.expireIfNeeded(pairing);
    if (!['waiting_scan', 'waiting_admin'].includes(pairing.status)) {
      throw new Error(`cannot deny channel pairing from ${pairing.status}`);
    }
    pairing.failureReason = reason;
    await this.transition(pairing, 'denied', reason);
    return this.toPublic(pairing);
  }

  private requirePairing(pairingId: string): StoredPairing {
    if (!PAIRING_ID_PATTERN.test(pairingId)) throw new Error('invalid channel pairing id');
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new Error('channel pairing was not found');
    return pairing;
  }

  private assertStatus(pairing: StoredPairing, expected: PairingStatus): void {
    if (pairing.status !== expected) {
      throw new Error(`channel pairing is ${pairing.status}, expected ${expected}`);
    }
  }

  private async expireIfNeeded(pairing: StoredPairing): Promise<void> {
    if (this.now() < pairing.expiresAtMs) return;
    if (['connected', 'expired', 'denied', 'failed', 'revoked'].includes(pairing.status)) return;
    pairing.failureReason = 'pairing expired';
    pairing.tokenHash.fill(0);
    await this.transition(pairing, 'expired', pairing.failureReason);
  }

  private async transition(
    pairing: StoredPairing,
    to: PairingStatus,
    reason?: string,
  ): Promise<void> {
    const from = pairing.status;
    pairing.status = to;
    await this.emit(pairing, from, to, reason);
  }

  private async emit(
    pairing: StoredPairing,
    from: PairingStatus | 'created',
    to: PairingStatus,
    reason?: string,
  ): Promise<void> {
    await this.options.audit({
      pairingId: pairing.pairingId,
      provider: pairing.provider,
      from,
      to,
      occurredAtMs: this.now(),
      ...(reason ? { reason } : {}),
    });
  }

  private toPublic(pairing: StoredPairing, nonce?: string): PairingSession {
    const query = nonce
      ? `?pairing=${encodeURIComponent(pairing.pairingId)}&nonce=${encodeURIComponent(nonce)}`
      : '';
    return {
      pairingId: pairing.pairingId,
      provider: pairing.provider,
      status: pairing.status,
      qrPayload: nonce ? `${this.publicPairingOrigin}/channel/pair${query}` : '',
      expiresAtMs: pairing.expiresAtMs,
      requestedScopes: [...pairing.requestedScopes],
      ...(pairing.authorization?.tenantName ? { tenantName: pairing.authorization.tenantName } : {}),
      ...(pairing.failureReason ? { failureReason: pairing.failureReason } : {}),
    };
  }
}
