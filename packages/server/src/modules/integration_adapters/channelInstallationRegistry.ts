/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 *
 * Durable public metadata for installed chat-channel connectors. Provider
 * credentials stay in their encrypted vaults; this registry only restores
 * routing after the local server restarts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  ChannelInstallation,
  ChannelProvider,
} from './channelConnector.js';

const INSTALLATION_ID = /^channel_(feishu|lark|wecom)_[a-f0-9]{24}$/;
const MAX_TEXT_LENGTH = 200;
const MAX_SCOPES = 50;

interface StoredChannelInstallationsV1 {
  schemaVersion: 1;
  installations: ChannelInstallation[];
}

export interface ChannelInstallationRegistry {
  list(): ChannelInstallation[];
  get(installationId: string): ChannelInstallation | undefined;
  upsert(installation: ChannelInstallation): void;
  remove(installationId: string): boolean;
}

function cloneInstallation(installation: ChannelInstallation): ChannelInstallation {
  return { ...installation, grantedScopes: [...installation.grantedScopes] };
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`channel installation ${field} is invalid`);
  }
  return value.trim();
}

function validateInstallation(value: unknown): ChannelInstallation {
  if (!value || typeof value !== 'object') {
    throw new Error('channel installation record is invalid');
  }
  const record = value as Partial<ChannelInstallation>;
  const installationId = boundedText(record.installationId, 'id');
  const idMatch = installationId.match(INSTALLATION_ID);
  if (!idMatch) throw new Error('channel installation id is invalid');
  const provider = record.provider;
  if (!['feishu', 'lark', 'wecom'].includes(provider ?? '')) {
    throw new Error('channel installation provider is invalid');
  }
  if (idMatch[1] !== provider) {
    throw new Error('channel installation provider does not match its id');
  }
  if (!Array.isArray(record.grantedScopes) || record.grantedScopes.length > MAX_SCOPES) {
    throw new Error('channel installation scopes are invalid');
  }
  const grantedScopes = [...new Set(record.grantedScopes.map((scope) => (
    boundedText(scope, 'scope')
  )))].sort();
  if (!Number.isFinite(record.connectedAtMs) || Number(record.connectedAtMs) < 0) {
    throw new Error('channel installation connectedAtMs is invalid');
  }
  return {
    installationId,
    provider: provider as ChannelProvider,
    tenantId: boundedText(record.tenantId, 'tenant id'),
    tenantName: boundedText(record.tenantName, 'tenant name'),
    botName: boundedText(record.botName, 'bot name'),
    grantedScopes,
    connectedAtMs: Number(record.connectedAtMs),
  };
}

export function defaultChannelInstallationRegistryPath(): string {
  const configured = process.env.CLAWMASTER_USER_DIR?.trim();
  const root = configured || path.join(os.homedir(), '.otto-user');
  return path.join(root, 'channel-installations.json');
}

export class FileChannelInstallationRegistry implements ChannelInstallationRegistry {
  private readonly installations = new Map<string, ChannelInstallation>();

  constructor(
    private readonly statePath = defaultChannelInstallationRegistryPath(),
  ) {
    this.load();
  }

  list(): ChannelInstallation[] {
    return [...this.installations.values()]
      .sort((left, right) => left.installationId.localeCompare(right.installationId))
      .map(cloneInstallation);
  }

  get(installationId: string): ChannelInstallation | undefined {
    const installation = this.installations.get(installationId);
    return installation ? cloneInstallation(installation) : undefined;
  }

  upsert(value: ChannelInstallation): void {
    const installation = validateInstallation(value);
    const existing = this.installations.get(installation.installationId);
    if (existing && existing.provider !== installation.provider) {
      throw new Error('channel installation provider cannot change');
    }
    if (existing && existing.tenantId !== installation.tenantId) {
      throw new Error('channel installation tenant cannot change');
    }
    this.installations.set(installation.installationId, installation);
    this.save();
  }

  remove(installationId: string): boolean {
    if (!this.installations.delete(installationId)) return false;
    this.save();
    return true;
  }

  private load(): void {
    try {
      const stored = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<StoredChannelInstallationsV1>;
      if (stored.schemaVersion !== 1 || !Array.isArray(stored.installations)) return;
      const restored = stored.installations.map(validateInstallation);
      for (const installation of restored) {
        if (this.installations.has(installation.installationId)) {
          throw new Error('duplicate channel installation id');
        }
        this.installations.set(installation.installationId, installation);
      }
    } catch {
      // Missing or damaged state fails closed. Keep the original file untouched
      // so support can inspect it instead of silently replacing evidence.
      this.installations.clear();
    }
  }

  private save(): void {
    const parent = path.dirname(this.statePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    const stored: StoredChannelInstallationsV1 = {
      schemaVersion: 1,
      installations: this.list(),
    };
    try {
      fs.writeFileSync(temporary, JSON.stringify(stored, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporary, this.statePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}
