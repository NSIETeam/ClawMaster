/** Authenticated same-origin enterprise requests and observable optimistic-concurrency state. */
import { z } from 'zod';
import { parseEnterpriseOverview, parseEnterprisePage, parseEnterpriseReceipt, parseEnterpriseRequest } from './enterprise-schema.ts';
import { ENTERPRISE_BACKUP_PREPARE_PATH, preparedBackupSchema, restoreBackupRequestSchema, restoreBackupReceiptSchema,
  type PreparedEnterpriseBackup, type RestoreBackupRequest, type RestoreBackupReceipt } from './enterprise-backup-format.ts';
import {
  enterpriseId, EnterpriseError, ENTERPRISE_BACKUP_PATH, ENTERPRISE_COMMAND_PATH, ENTERPRISE_QUERY_PATH, ENTERPRISE_RESTORE_PATH, ENTERPRISE_SNAPSHOT_PATH,
  type EnterpriseCommand, type EnterpriseCommandRequest, type EnterpriseErrorCode,
  type EnterpriseId, type EnterpriseOverview, type EnterpriseQueryPage, type EnterpriseQuerySpec,
} from './enterprise-types.ts';

/** User-visible failure categories; transport failures leave mutation outcomes unresolved. */
export type EnterpriseClientErrorCode = EnterpriseErrorCode | 'permission_denied' | 'operation_cancelled' | 'networkError' | 'invalidResponse' | 'pending_command' | 'stale_form';

/** Current database counters and mutation state; records belong to individual bounded pages. */
export interface EnterpriseClientState {
  overview: EnterpriseOverview | null;
  loading: boolean;
  saving: boolean;
  pending: boolean;
  /** A failed authoritative read requires refresh before further edits. */
  readUnavailable: boolean;
  /** A restore response was lost; only its exact receipt retry resolves the outcome. */
  restoreUncertain?: boolean;
  backupOperation: 'prepare' | 'restore' | null;
  error: EnterpriseClientErrorCode | null;
}

const failureSchema = z.object({ error: z.object({
  code: z.enum(['invalid_request', 'revision_conflict', 'command_conflict', 'not_found', 'duplicate_sku',
    'referenced_item', 'submitted_order', 'insufficient_stock', 'numeric_overflow', 'storage_unavailable', 'storage_invalid', 'result_too_large', 'permission_denied']),
  message: z.string(), currentRevision: z.number().int().min(0).optional(),
}) });

/** HTTP implementation injectable for isolated transport tests. */
export type EnterpriseFetch = (input: string, init: RequestInit) => Promise<Response>;

class EnterpriseClientFailure extends Error {
  constructor(readonly code: EnterpriseClientErrorCode, message: string) { super(message); }
}

/**
 * Owns business version counters and one idempotent mutation at a time. Uncertain writes
 * retain their original request until an explicit retry obtains a known outcome.
 */
export class EnterpriseClient {
  private state: EnterpriseClientState = { overview: null, loading: false, saving: false, pending: false, readUnavailable: false, backupOperation: null, error: null };
  private readonly listeners = new Set<() => void>();
  private pendingRequest: EnterpriseCommandRequest | undefined;
  private restoreUncertain = false;
  private pendingRestore: { request: RestoreBackupRequest; backupRevision: number } | undefined;
  private backupController: AbortController | undefined;
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

  /** Read current counters without discarding inputs or unresolved writes. */
  async refresh(): Promise<void> {
    if (this.state.saving) return;
    const generation = ++this.generation;
    this.set({ loading: true, error: null });
    try {
      const response = await this.fetcher(ENTERPRISE_SNAPSHOT_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      let json: unknown;
      try { json = await response.json(); } catch {
        if (generation === this.generation) this.set({ error: 'invalidResponse', readUnavailable: true });
        return;
      }
      if (generation !== this.generation) return;
      if (!response.ok) {
        const failure = failureSchema.safeParse(json);
        this.set({ error: failure.success ? failure.data.error.code : 'invalidResponse', readUnavailable: true });
        return;
      }
      let overview: EnterpriseOverview;
      try { overview = parseEnterpriseOverview(json); } catch {
        this.set({ error: 'invalidResponse', readUnavailable: true });
        return;
      }
      this.set({ overview, pending: this.pendingRequest !== undefined || this.pendingRestore !== undefined,
        restoreUncertain: this.restoreUncertain, readUnavailable: false });
    } catch {
      if (generation === this.generation) this.set({ error: 'networkError', readUnavailable: true });
    } finally {
      if (generation === this.generation) this.set({ loading: false });
    }
  }

  /**
   * Read one page at the caller's reviewed database version.
   * @param query Collection, bounded window, filters and generation/revision pair.
   * @param signal Cancel a page whose component or filters have changed.
   * @returns The validated page, never a partial enterprise snapshot.
   */
  async query(query: EnterpriseQuerySpec, signal?: AbortSignal): Promise<EnterpriseQueryPage> {
    const generation = this.generation;
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) parameters.set(key, String(value));
    try {
      const response = await this.fetcher(`${ENTERPRISE_QUERY_PATH}?${parameters}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) });
      const json: unknown = await response.json();
      if (!response.ok) {
        const failure = failureSchema.safeParse(json);
        if (!failure.success) throw new EnterpriseError('storage_invalid', 'Enterprise page response is invalid.');
        throw new EnterpriseClientFailure(failure.data.error.code, failure.data.error.message);
      }
      const page = parseEnterprisePage(json);
      if (page.collection !== query.collection || page.offset !== query.offset || page.records.length > query.limit
        || (query.generation !== undefined && page.generation !== query.generation)
        || (query.revision !== undefined && page.revision !== query.revision)
        || (query.id !== undefined && page.records.some(record => 'id' in record ? record.id !== query.id : record.entityId !== query.id && record.commandId !== query.id))) {
        throw new EnterpriseError('storage_invalid', 'Enterprise page does not match its request.');
      }
      return page;
    } catch (error) {
      if (generation === this.generation && !signal?.aborted) this.set({ error: error instanceof EnterpriseError || error instanceof EnterpriseClientFailure ? error.code : 'invalidResponse', readUnavailable: true });
      throw error;
    }
  }

  /** Download the backup as a file without materializing its JSON records in the client. */
  async backup(): Promise<Blob> {
    const response = await this.fetcher(ENTERPRISE_BACKUP_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new EnterpriseError('storage_unavailable', 'Enterprise backup could not be read.');
    return response.blob();
  }

  /**
   * Upload a backup file for bounded server validation without reading its text in the browser.
   * @param file Original user-selected file or blob.
   * @returns Counts, digest and temporary token for an explicit restore review.
   */
  async prepareBackup(file: Blob): Promise<PreparedEnterpriseBackup> {
    if (this.state.saving || this.state.pending) throw new EnterpriseError('invalid_request', 'Resolve the current enterprise operation before restoring.');
    this.generation++;
    const controller = new AbortController();
    this.backupController = controller;
    this.set({ loading: false, saving: true, backupOperation: 'prepare', error: null });
    try {
      const response = await this.fetcher(ENTERPRISE_BACKUP_PREPARE_PATH, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: file, signal: controller.signal,
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const failure = failureSchema.safeParse(json);
        if (!failure.success) throw new EnterpriseClientFailure('invalidResponse', 'Backup preparation response is invalid.');
        throw new EnterpriseClientFailure(failure.data.error.code, failure.data.error.message);
      }
      if (controller.signal.aborted) throw new EnterpriseClientFailure('operation_cancelled', 'Backup preparation was cancelled.');
      const prepared = preparedBackupSchema.safeParse(json);
      if (!prepared.success) throw new EnterpriseClientFailure('invalidResponse', 'Backup preparation metadata is invalid.');
      return prepared.data;
    } catch (error) {
      this.set({ error: controller.signal.aborted ? 'operation_cancelled' : error instanceof EnterpriseClientFailure ? error.code : 'networkError' });
      throw error;
    } finally {
      this.backupController = undefined;
      this.set({ saving: false, backupOperation: null });
    }
  }

  /** Abort the active upload or restore request; a restore retains its exact unresolved receipt query. */
  cancelBackupOperation(): void { this.backupController?.abort(); }

  /**
   * Restore a server-validated file after the operator reviews its metadata and current database version.
   * @param backup Validated preparation metadata.
   * @param expectedRevision Database revision explicitly reviewed by the operator.
   * @param expectedGeneration Database restore generation explicitly reviewed by the operator.
   * @returns A validated durable receipt for exactly this restore command.
   */
  async restore(backup: PreparedEnterpriseBackup, expectedRevision: number, expectedGeneration: number): Promise<RestoreBackupReceipt> {
    if (this.state.saving || this.state.pending) throw new EnterpriseError('invalid_request', 'Resolve the current enterprise operation before restoring.');
    const prepared = preparedBackupSchema.parse(backup);
    const request = restoreBackupRequestSchema.parse({ token: prepared.token, backupSha256: prepared.backupSha256,
      expectedRevision, expectedGeneration, commandId: this.nextId(), confirm: true });
    const pending = { request, backupRevision: prepared.revision };
    this.pendingRestore = pending;
    return this.sendRestore(pending, false);
  }

  /** Reissue the original restore request; refreshing or changing panels never changes its command identifier. */
  async retryRestore(): Promise<RestoreBackupReceipt | null> {
    if (!this.pendingRestore || this.state.saving) return null;
    return this.sendRestore(this.pendingRestore, true);
  }

  private async sendRestore(pending: { request: RestoreBackupRequest; backupRevision: number }, retry: boolean): Promise<RestoreBackupReceipt> {
    this.generation++;
    const controller = new AbortController();
    this.backupController = controller;
    this.restoreUncertain = true;
    this.set({ loading: false, saving: true, pending: true, restoreUncertain: true, backupOperation: 'restore', error: null });
    let knownFailure = false;
    let restored = false;
    try {
      const response = await this.fetcher(ENTERPRISE_RESTORE_PATH, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pending.request), signal: controller.signal,
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const failure = failureSchema.safeParse(json);
        if (!failure.success) throw new EnterpriseClientFailure('invalidResponse', 'Enterprise restore response is invalid.');
        knownFailure = !controller.signal.aborted && (!retry || failure.data.error.code === 'invalid_request')
          && !['storage_unavailable', 'storage_invalid'].includes(failure.data.error.code);
        throw new EnterpriseClientFailure(failure.data.error.code, failure.data.error.message);
      }
      const result = restoreBackupReceiptSchema.safeParse(json);
      const request = pending.request;
      if (!result.success || result.data.commandId !== request.commandId || result.data.backupSha256 !== request.backupSha256
        || result.data.generation !== request.expectedGeneration + 1 || result.data.revision !== pending.backupRevision) {
        throw new EnterpriseClientFailure('invalidResponse', 'Enterprise restore acknowledgement is invalid.');
      }
      restored = true;
      this.pendingRestore = undefined;
      this.restoreUncertain = false;
      this.set({ pending: false, restoreUncertain: false, error: null });
      return result.data;
    } catch (error) {
      if (knownFailure) { this.pendingRestore = undefined; this.restoreUncertain = false; }
      this.set({ pending: this.pendingRestore !== undefined, restoreUncertain: this.restoreUncertain,
        error: controller.signal.aborted ? 'operation_cancelled' : error instanceof EnterpriseClientFailure ? error.code : 'networkError' });
      throw error;
    } finally {
      this.backupController = undefined;
      this.set({ saving: false, backupOperation: null });
      if (restored) await this.refresh();
    }
  }

  /**
   * Save one command against the revision captured when its draft or confirmation opened.
   * @param command User-reviewed operation.
   * @param revision Revision whose records the user reviewed; refresh never rebases a draft.
   * @param reviewedGeneration Database restore counter captured with the reviewed revision; legacy callers belong to generation zero.
   * @returns Whether the operation was confirmed committed.
   */
  async execute(command: EnterpriseCommand, revision: number, reviewedGeneration = 0): Promise<boolean> {
    if (this.state.saving) return false;
    if (this.pendingRequest || this.restoreUncertain) { this.set({ error: 'pending_command' }); return false; }
    if (!this.state.overview) { this.set({ error: 'storage_unavailable' }); return false; }
    if (reviewedGeneration !== this.state.overview.generation) {
      this.set({ error: 'stale_form' });
      return false;
    }
    let request: EnterpriseCommandRequest;
    try {
      request = parseEnterpriseRequest({ generation: reviewedGeneration, revision, commandId: this.nextId(), command });
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
    let committed = false;
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
        const refused = [400, 403, 404, 409, 413].includes(response.status);
        if (refused) this.pendingRequest = undefined;
        this.set({ pending: !refused, error: failure.data.error.code });
        return false;
      }
      let receipt;
      try { receipt = parseEnterpriseReceipt(json); } catch { this.set({ error: 'invalidResponse' }); return false; }
      const entityId = request.command.type === 'contact.upsert' ? request.command.contact.id
        : request.command.type === 'item.upsert' ? request.command.item.id
        : request.command.type === 'order.save' ? request.command.order.id : request.command.id;
      if (receipt.commandId !== request.commandId || receipt.type !== request.command.type || receipt.entityId !== entityId
        || receipt.generation !== request.generation || receipt.commandRevision !== request.revision + 1
        || receipt.revision < receipt.commandRevision) {
        this.set({ error: 'invalidResponse' });
        return false;
      }
      this.pendingRequest = undefined;
      committed = true;
      this.set({ pending: false, error: null });
      return true;
    } catch {
      this.set({ error: 'networkError' });
      return false;
    } finally {
      this.set({ saving: false });
      if (committed) await this.refresh();
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
