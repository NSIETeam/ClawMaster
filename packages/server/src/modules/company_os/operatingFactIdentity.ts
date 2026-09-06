import type { CanonicalEvent } from './index.js';

export const OPERATING_EVENT_TYPES = [
  'companyos.profit.line.v1',
  'companyos.inventory.line.v1',
  'companyos.cash.snapshot.v1',
  'companyos.growth.line.v1',
] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_operating_payload');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new Error('invalid_operating_identity');
  const normalized = value.replace(/^ +| +$/gu, '');
  if (
    !normalized
    || Buffer.byteLength(normalized, 'utf8') > 512
    || [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error('invalid_operating_identity');
  }
  return normalized;
}

function tuple(values: string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
}

/** Stable identity used by both the durable projection and Brief selection. */
export function operatingFactKey(event: CanonicalEvent): string | null {
  if (!(OPERATING_EVENT_TYPES as readonly string[]).includes(event.type)) return null;
  try {
    const payload = object(event.payload);
    if (event.type === 'companyos.profit.line.v1') {
      return tuple([text(payload.skuId), text(payload.channelId), text(payload.storeId, true)]);
    }
    if (event.type === 'companyos.inventory.line.v1') {
      return tuple([text(payload.skuId), text(payload.warehouseId)]);
    }
    if (event.type === 'companyos.growth.line.v1') {
      return tuple([
        text(payload.channelId), text(payload.skuId, true), text(payload.campaignId, true),
      ]);
    }
    return 'singleton';
  } catch {
    // Keep one current malformed fact per type visible to validation without
    // allowing malformed identities to create an unbounded projection.
    return 'invalid';
  }
}
