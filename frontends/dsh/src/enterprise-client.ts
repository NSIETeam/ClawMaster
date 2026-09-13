/** Authenticated same-origin enterprise requests and observable optimistic-concurrency state. */
import { z } from 'zod';
import { parseEnterpriseRequest, parseEnterpriseSnapshot } from './enterprise-schema.ts';
import {
  enterpriseId, EnterpriseError, ENTERPRISE_COMMAND_PATH, ENTERPRISE_SNAPSHOT_PATH,
  type EnterpriseCommand, type EnterpriseCommandRequest, type EnterpriseErrorCode,
  type EnterpriseId, type EnterpriseSnapshot,
} from './enterprise-types.ts';

/** User-visible failure categories; transport failures leave mutation outcomes unresolved. */
export type EnterpriseClientErrorCode = EnterpriseErrorCode | 'networkError' | 'invalidResponse' | 'pending_command';

/** A complete view of the client's current records and in-flight operations. */
export interface EnterpriseClientState {
  snapshot: EnterpriseSnapshot | null;
  loading: boolean;
  saving: boolean;
  pending: boolean;
  error: EnterpriseClientErrorCode | null;
}

const failureSchema = z.object({ error: z.object({
  code: z.enum(['invalid_request', 'revision_conflict', 'command_conflict', 'not_found', 'duplicate_sku',
    'referenced_item', 'submitted_order', 'insufficient_stock', 'numeric_overflow', 'storage_unavailable', 'storage_invalid']),
  message: z.string(), currentRevision: z.number().int().min(0).optional(),
}) });

/** HTTP implementation injectable for isolated transport tests. */
export type EnterpriseFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Owns business snapshots and one idempotent mutation at a time. Uncertain writes
 * retain their original request until an explicit retry obtains a known outcome.
 */
export class EnterpriseClient {
  private state: EnterpriseClientState = { snapshot: null, loading: false, saving: false, pending: false, error: null };
  private readonly listeners = new Set<() => void>();
  private pendingRequest: EnterpriseCommandRequest | undefined;
  private generation = 0;
  private readonly fetcher: EnterpriseFetch;
  private readonly nextId: () => EnterpriseId;

  constructor(
    fetcher: EnterpriseFetch = (input, init) => globalThis.fetch(input, init),
    nextId: () => EnterpriseId = () => enterpriseId(crypto.randomUUID()),
  ) { this.fetcher = fetcher; this.nextId = nextId; }

  /** Return the stable observable state object until the next state change. */
  getSnapshot = (): EnterpriseClientState => this.state;

  /** Subscribe to client state; the returned function removes the listener. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<EnterpriseClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Read a validated snapshot without discarding inputs or unresolved writes. */
  async refresh(): Promise<void> {
    if (this.state.saving) return;
    const generation = ++this.generation;
    this.set({ loading: true, error: null });
    try {
      const response = await this.fetcher(ENTERPRISE_SNAPSHOT_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      let json: unknown;
      try { json = await response.json(); } catch {
        if (generation === this.generation) this.set({ error: 'invalidResponse' });
        return;
      }
      if (generation !== this.generation) return;
      if (!response.ok) {
        const failure = failureSchema.safeParse(json);
        this.set({ error: failure.success ? failure.data.error.code : 'invalidResponse' });
        return;
      }
      let snapshot: EnterpriseSnapshot;
      try { snapshot = parseEnterpriseSnapshot(json); } catch {
        this.set({ error: 'invalidResponse' });
        return;
      }
      this.set({ snapshot });
    } catch {
      if (generation === this.generation) this.set({ error: 'networkError' });
    } finally {
      if (generation === this.generation) this.set({ loading: false });
    }
  }

  /**
   * Save one command against the revision captured when its draft or confirmation opened.
   * @param command User-reviewed operation.
   * @param revision Revision whose records the user reviewed; refresh never rebases a draft.
   * @returns Whether the operation was confirmed committed.
   */
  async execute(command: EnterpriseCommand, revision: number): Promise<boolean> {
    if (this.state.saving) return false;
    if (this.pendingRequest) { this.set({ error: 'pending_command' }); return false; }
    if (!this.state.snapshot) { this.set({ error: 'storage_unavailable' }); return false; }
    let request: EnterpriseCommandRequest;
    try {
      request = parseEnterpriseRequest({ revision, commandId: this.nextId(), command });
    } catch (error) {
      this.set({ error: error instanceof EnterpriseError ? error.code : 'invalid_request' });
      return false;
    }
    return this.send(request);
  }

  /**
   * Replay the exact unresolved request using its original idempotency key.
   * @returns The confirmed command, or null when there is no resolved mutation.
   */
  async retryPending(): Promise<EnterpriseCommand | null> {
    const request = this.pendingRequest;
    if (!request || this.state.saving) return null;
    return await this.send(request) ? request.command : null;
  }

  private async send(request: EnterpriseCommandRequest): Promise<boolean> {
    this.generation++;
    this.pendingRequest = request;
    this.set({ loading: false, saving: true, pending: true, error: null });
    try {
      const response = await this.fetcher(ENTERPRISE_COMMAND_PATH, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      });
      let json: unknown;
      try { json = await response.json(); } catch { this.set({ error: 'invalidResponse' }); return false; }
      if (!response.ok) {
        const failure = failureSchema.safeParse(json);
        if (!failure.success) { this.set({ error: 'invalidResponse' }); return false; }
        this.pendingRequest = undefined;
        this.set({ pending: false, error: failure.data.error.code });
        return false;
      }
      let snapshot: EnterpriseSnapshot;
      try { snapshot = parseEnterpriseSnapshot(json); } catch { this.set({ error: 'invalidResponse' }); return false; }
      if (!snapshot.audit.some(entry => entry.commandId === request.commandId && entry.type === request.command.type)) {
        this.set({ error: 'invalidResponse' });
        return false;
      }
      this.pendingRequest = undefined;
      this.set({ snapshot, pending: false, error: null });
      return true;
    } catch {
      this.set({ error: 'networkError' });
      return false;
    } finally {
      this.set({ saving: false });
    }
  }
}

/** Shared across CRM and ERP so unresolved writes survive panel navigation. */
export const enterpriseClient = new EnterpriseClient();

/**
 * Convert a decimal input to integer CNY minor units without rounding.
 * @param input Nonnegative decimal amount with at most two fractional digits.
 * @returns Exact safe-integer minor units.
 * @throws EnterpriseError for malformed or out-of-range amounts.
 */
export function moneyInputToMinorUnits(input: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) throw new EnterpriseError('invalid_request', 'Invalid decimal price.');
  const [whole, fractional = ''] = input.split('.');
  const units = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new EnterpriseError('numeric_overflow', 'Price exceeds the supported range.');
  return Number(units);
}

/**
 * Format validated minor units for an editable decimal field.
 * @param units Safe-integer CNY minor units.
 * @returns A decimal string with exactly two fractional digits.
 */
export function minorUnitsToMoneyInput(units: number): string {
  const value = BigInt(units);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/**
 * Parse a stock or order quantity without fractions, exponents, or rounding.
 * @param input Nonnegative integral decimal input.
 * @param minimum Minimum accepted quantity, such as zero for stock or one for orders.
 * @returns A safe integer.
 * @throws EnterpriseError for invalid or out-of-range quantities.
 */
export function quantityInputToInteger(input: string, minimum: number): number {
  if (!/^\d+$/.test(input)) throw new EnterpriseError('invalid_request', 'Invalid integral quantity.');
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new EnterpriseError('numeric_overflow', 'Quantity exceeds the supported range.');
  if (value < minimum) throw new EnterpriseError('invalid_request', 'Quantity is below the minimum.');
  return value;
}
