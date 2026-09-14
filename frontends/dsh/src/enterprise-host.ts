/** SQLite enterprise records and authenticated DSH Fetch routes; owns no listener or Session. */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  EnterpriseError, ENTERPRISE_COMMAND_PATH, ENTERPRISE_SNAPSHOT_PATH,
  ENTERPRISE_BACKUP_PATH, ENTERPRISE_RESTORE_PATH,
} from './enterprise-types.ts';
import type {
  AuditEntry, BusinessOrder, Contact, EnterpriseCommand, EnterpriseCommandRequest, EnterpriseSnapshot, InventoryItem, EnterpriseBackup,
} from './enterprise-types.ts';
import {
  contactSchema, itemSchema, orderSchema, auditSchema, parseEnterpriseRequest,
  parseEnterpriseBackup, parseEnterpriseRestoreRequest, parseEnterpriseSnapshot, enterpriseOrderTotal,
} from './enterprise-schema.ts';

const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x434d454e;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sqliteRow = z.record(z.string(), z.unknown());

/** Public database owner; close is idempotent and rejects all subsequent operations. */
export class EnterpriseStore {
  private closed = false;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  private assertOpen(): void {
    if (this.closed) throw new EnterpriseError('storage_unavailable', 'Enterprise storage is closed.');
  }

  private revision(): number {
    const result = this.db.prepare('SELECT revision FROM enterprise_meta WHERE singleton = 1').get();
    return z.object({ revision: integer }).strict().parse(result).revision;
  }

  private contacts(): Contact[] {
    return this.db.prepare('SELECT * FROM contacts ORDER BY name, id').all().map(row => contactSchema.parse(row));
  }

  private items(): InventoryItem[] {
    return this.db.prepare('SELECT * FROM inventory ORDER BY sku, id').all().map(row => itemSchema.parse(row));
  }

  private orders(): BusinessOrder[] {
    return this.db.prepare('SELECT * FROM orders ORDER BY updatedAt DESC, id').all().map(row => {
      const header = sqliteRow.parse(row);
      const lines = this.db.prepare('SELECT itemId, quantity, unitPriceMinorUnits FROM order_lines WHERE orderId = ? ORDER BY position')
        .all(String(header.id));
      return orderSchema.parse({ ...header, lines });
    });
  }

  private readSnapshot(): EnterpriseSnapshot {
    const revision = this.revision();
    const audit = this.db.prepare('SELECT revision, commandId, type, entityId, at, beforeJson, afterJson FROM enterprise_audit ORDER BY revision DESC')
      .all().map(value => {
        const row = sqliteRow.parse(value);
        return auditSchema.parse({
          revision: row.revision, commandId: row.commandId, type: row.type, entityId: row.entityId,
          at: row.at, before: JSON.parse(String(row.beforeJson)), after: JSON.parse(String(row.afterJson)),
        });
      });
    return parseEnterpriseSnapshot({ revision, contacts: this.contacts(), inventory: this.items(), orders: this.orders(), audit });
  }

  /**
   * Read a consistent full snapshot, including its audit history.
   * @returns Validated records observed in a single SQLite read transaction.
   */
  snapshot(): EnterpriseSnapshot {
    this.assertOpen();
    this.db.exec('BEGIN');
    try {
      const result = this.readSnapshot();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise records cannot be read.');
    }
  }

  /** Read a restore-capable backup, retaining command receipts for idempotent replay. */
  backup(): EnterpriseBackup {
    const snapshot = this.snapshot();
    const auditCommands = this.db.prepare('SELECT revision, commandId, commandJson FROM enterprise_audit ORDER BY revision').all()
      .map(value => {
        const row = sqliteRow.parse(value);
        return { revision: integer.parse(row.revision), commandId: String(row.commandId) as EnterpriseBackup['auditCommands'][number]['commandId'], commandJson: String(row.commandJson) };
      });
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), snapshot, auditCommands };
  }

  /**
   * Restore a validated backup only when the caller proves the database has
   * not changed since its confirmation. The replacement and audit receipts
   * commit atomically; a failed validation or write leaves the current data.
   * @param value Complete backup envelope obtained from {@link backup}.
   * @param expectedRevision Revision the operator explicitly confirmed.
   * @returns The restored snapshot.
   */
  restore(value: unknown, expectedRevision: number): EnterpriseSnapshot {
    this.assertOpen();
    const backup = parseEnterpriseBackup(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new EnterpriseError('invalid_request', 'Restore confirmation revision is invalid.');
    }
    if (this.revision() !== expectedRevision) {
      throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Refresh before restoring.', this.revision());
    }
    const commands = new Map(backup.auditCommands.map(entry => {
      let command: unknown;
      try { command = JSON.parse(entry.commandJson); } catch { throw new EnterpriseError('storage_invalid', 'Enterprise backup command JSON is malformed.'); }
      const parsed = parseEnterpriseRequest({ revision: entry.revision - 1, commandId: entry.commandId, command });
      const audit = backup.snapshot.audit.find(candidate => candidate.revision === entry.revision);
      if (!audit || audit.type !== parsed.command.type) throw new EnterpriseError('storage_invalid', 'Enterprise backup command does not match its audit entry.');
      return [entry.revision, entry.commandJson] as const;
    }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM order_lines; DELETE FROM orders; DELETE FROM contacts; DELETE FROM inventory; DELETE FROM enterprise_audit;');
      const insertContact = this.db.prepare('INSERT INTO contacts (id, name, company, stage, nextAction, nextActionDate, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of backup.snapshot.contacts) insertContact.run(row.id, row.name, row.company, row.stage, row.nextAction, row.nextActionDate, row.updatedAt);
      const insertItem = this.db.prepare('INSERT INTO inventory (id, sku, name, stock, reorderAt, supplier, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of backup.snapshot.inventory) insertItem.run(row.id, row.sku, row.name, row.stock, row.reorderAt, row.supplier, row.updatedAt);
      const insertOrder = this.db.prepare('INSERT INTO orders (id, kind, counterparty, orderDate, currency, status, totalMinorUnits, note, updatedAt, submittedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertLine = this.db.prepare('INSERT INTO order_lines (orderId, position, itemId, quantity, unitPriceMinorUnits) VALUES (?, ?, ?, ?, ?)');
      for (const row of backup.snapshot.orders) {
        insertOrder.run(row.id, row.kind, row.counterparty, row.orderDate, row.currency, row.status, row.totalMinorUnits, row.note, row.updatedAt, row.submittedAt);
        row.lines.forEach((line, position) => insertLine.run(row.id, position, line.itemId, line.quantity, line.unitPriceMinorUnits));
      }
      const auditByRevision = new Map(backup.snapshot.audit.map(entry => [entry.revision, entry]));
      const insertAudit = this.db.prepare('INSERT INTO enterprise_audit (revision, commandId, type, entityId, at, commandJson, beforeJson, afterJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (let revision = 1; revision <= backup.snapshot.revision; revision++) {
        const entry = auditByRevision.get(revision);
        const commandJson = commands.get(revision);
        if (!entry || commandJson === undefined) throw new EnterpriseError('storage_invalid', 'Enterprise backup audit revisions are incomplete.');
        insertAudit.run(entry.revision, entry.commandId, entry.type, entry.entityId, entry.at, commandJson, JSON.stringify(entry.before), JSON.stringify(entry.after));
      }
      this.db.prepare('UPDATE enterprise_meta SET revision = ? WHERE singleton = 1').run(backup.snapshot.revision);
      const result = this.readSnapshot();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise backup could not be restored.');
    }
  }

  private isReplay(request: EnterpriseCommandRequest): boolean {
    const receipt = this.db.prepare('SELECT commandJson FROM enterprise_audit WHERE commandId = ?').get(request.commandId);
    if (!receipt) return false;
    if (z.object({ commandJson: z.string() }).strict().parse(receipt).commandJson !== JSON.stringify(request.command)) {
      throw new EnterpriseError('command_conflict', 'Command identifier was already used for a different command.');
    }
    return true;
  }

  /**
   * Validate a command against a consistent state before requesting approval.
   * @param value Untrusted command envelope, identical to execute's input.
   * @returns Validated request, reviewed snapshot and an existing receipt for an exact replay.
   */
  prepare(value: unknown): { request: EnterpriseCommandRequest; snapshot: EnterpriseSnapshot; receipt?: AuditEntry } {
    this.assertOpen();
    const request = parseEnterpriseRequest(value);
    this.db.exec('BEGIN');
    try {
      const replay = this.isReplay(request);
      const snapshot = this.readSnapshot();
      if (!replay && request.revision !== snapshot.revision) {
        throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Reload before saving.', snapshot.revision);
      }
      const receipt = replay ? snapshot.audit.find(entry => entry.commandId === request.commandId) : undefined;
      this.db.exec('COMMIT');
      return { request, snapshot, ...(receipt ? { receipt } : {}) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise command cannot be prepared.');
    }
  }

  /**
   * Commit stock changes, revision, and audit together; replayed commands do not mutate again.
   * @param value Untrusted command request JSON.
   * @returns The full snapshot after the command or its idempotent replay.
   */
  execute(value: unknown): EnterpriseSnapshot {
    this.assertOpen();
    const request = parseEnterpriseRequest(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const serialized = JSON.stringify(request.command);
      if (this.isReplay(request)) {
        const result = this.readSnapshot();
        this.db.exec('COMMIT');
        return result;
      }
      const revision = this.revision();
      if (request.revision !== revision) throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Reload before saving.', revision);
      if (!Number.isSafeInteger(revision + 1)) throw new EnterpriseError('numeric_overflow', 'Enterprise revision exceeds the supported integer range.');
      const at = new Date().toISOString();
      const change = this.apply(request.command, at);
      this.db.prepare('INSERT INTO enterprise_audit (revision, commandId, type, entityId, at, commandJson, beforeJson, afterJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(revision + 1, request.commandId, request.command.type, change.id, at, serialized, JSON.stringify(change.before), JSON.stringify(change.after));
      this.db.prepare('UPDATE enterprise_meta SET revision = ? WHERE singleton = 1').run(revision + 1);
      const result = this.readSnapshot();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise command could not be committed.');
    }
  }

  private apply(command: EnterpriseCommand, at: string): { id: string; before: unknown; after: unknown } {
    switch (command.type) {
      case 'contact.upsert': {
        const contact = { ...command.contact, updatedAt: at };
        const before = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) ?? null;
        this.db.prepare(`INSERT INTO contacts (id, name, company, stage, nextAction, nextActionDate, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, company=excluded.company, stage=excluded.stage, nextAction=excluded.nextAction, nextActionDate=excluded.nextActionDate, updatedAt=excluded.updatedAt`)
          .run(contact.id, contact.name, contact.company, contact.stage, contact.nextAction, contact.nextActionDate, at);
        return { id: contact.id, before, after: contact };
      }
      case 'contact.remove': {
        const before = this.requireRow('contacts', command.id);
        this.db.prepare('DELETE FROM contacts WHERE id = ?').run(command.id);
        return { id: command.id, before, after: null };
      }
      case 'item.upsert': {
        const item = { ...command.item, updatedAt: at };
        const duplicate = this.db.prepare('SELECT id FROM inventory WHERE sku = ? AND id <> ?').get(item.sku, item.id);
        if (duplicate) throw new EnterpriseError('duplicate_sku', 'Another inventory item already uses this SKU.');
        const before = this.db.prepare('SELECT * FROM inventory WHERE id = ?').get(item.id) ?? null;
        this.db.prepare(`INSERT INTO inventory (id, sku, name, stock, reorderAt, supplier, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, name=excluded.name, stock=excluded.stock, reorderAt=excluded.reorderAt, supplier=excluded.supplier, updatedAt=excluded.updatedAt`)
          .run(item.id, item.sku, item.name, item.stock, item.reorderAt, item.supplier, at);
        return { id: item.id, before, after: item };
      }
      case 'item.remove': {
        const before = this.requireRow('inventory', command.id);
        if (this.db.prepare('SELECT orderId FROM order_lines WHERE itemId = ? LIMIT 1').get(command.id)) {
          throw new EnterpriseError('referenced_item', 'Inventory item is referenced by an order.');
        }
        this.db.prepare('DELETE FROM inventory WHERE id = ?').run(command.id);
        return { id: command.id, before, after: null };
      }
      case 'order.save': {
        const before = this.orders().find(order => order.id === command.order.id) ?? null;
        if (before?.status === 'submitted') throw new EnterpriseError('submitted_order', 'Submitted orders cannot be changed.');
        for (const line of command.order.lines) this.requireRow('inventory', line.itemId);
        const order: BusinessOrder = { ...command.order, status: 'draft', totalMinorUnits: enterpriseOrderTotal(command.order), updatedAt: at, submittedAt: null };
        this.db.prepare(`INSERT INTO orders (id, kind, counterparty, orderDate, currency, status, totalMinorUnits, note, updatedAt, submittedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, counterparty=excluded.counterparty, orderDate=excluded.orderDate, currency=excluded.currency, totalMinorUnits=excluded.totalMinorUnits, note=excluded.note, updatedAt=excluded.updatedAt`)
          .run(order.id, order.kind, order.counterparty, order.orderDate, order.currency, order.status, order.totalMinorUnits, order.note, at, null);
        this.db.prepare('DELETE FROM order_lines WHERE orderId = ?').run(order.id);
        const insert = this.db.prepare('INSERT INTO order_lines (orderId, position, itemId, quantity, unitPriceMinorUnits) VALUES (?, ?, ?, ?, ?)');
        order.lines.forEach((line, index) => insert.run(order.id, index, line.itemId, line.quantity, line.unitPriceMinorUnits));
        return { id: order.id, before, after: order };
      }
      case 'order.remove': {
        const before = this.orders().find(order => order.id === command.id);
        if (!before) throw new EnterpriseError('not_found', 'Order does not exist.');
        if (before.status === 'submitted') throw new EnterpriseError('submitted_order', 'Submitted orders cannot be removed.');
        this.db.prepare('DELETE FROM orders WHERE id = ?').run(command.id);
        return { id: command.id, before, after: null };
      }
      case 'order.submit': {
        const order = this.orders().find(candidate => candidate.id === command.id);
        if (!order) throw new EnterpriseError('not_found', 'Order does not exist.');
        if (order.status === 'submitted') throw new EnterpriseError('submitted_order', 'Order has already been submitted.');
        const beforeItems: InventoryItem[] = [];
        const afterItems: InventoryItem[] = [];
        for (const line of order.lines) {
          const item = itemSchema.parse(this.requireRow('inventory', line.itemId));
          const stock = item.stock + (order.kind === 'purchase' ? line.quantity : -line.quantity);
          if (stock < 0) throw new EnterpriseError('insufficient_stock', 'An order item has insufficient stock.');
          if (!Number.isSafeInteger(stock)) throw new EnterpriseError('numeric_overflow', 'Stock exceeds the supported integer range.');
          this.db.prepare('UPDATE inventory SET stock = ?, updatedAt = ? WHERE id = ?').run(stock, at, item.id);
          beforeItems.push(item);
          afterItems.push({ ...item, stock, updatedAt: at });
        }
        const submitted: BusinessOrder = { ...order, status: 'submitted', submittedAt: at, updatedAt: at };
        this.db.prepare("UPDATE orders SET status = 'submitted', submittedAt = ?, updatedAt = ? WHERE id = ?").run(at, at, order.id);
        return { id: order.id, before: { order, inventory: beforeItems }, after: { order: submitted, inventory: afterItems } };
      }
      default:
        command satisfies never;
        throw new EnterpriseError('invalid_request', 'Unknown enterprise command.');
    }
  }

  private requireRow(table: 'contacts' | 'inventory', id: string) {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new EnterpriseError('not_found', 'Enterprise record does not exist.');
    return row;
  }

  /** Release the connection after its routes have been removed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Open an owned database without migrating, replacing, or resetting existing data.
 * @param databasePath SQLite file path; the caller supplies the DSH home location.
 * @param busyTimeoutMs Maximum SQLite writer-lock wait in milliseconds.
 * @returns An open database owner; callers must close it after removing its routes.
 */
export async function openEnterpriseStore(databasePath: string, busyTimeoutMs = 5000): Promise<EnterpriseStore> {
  z.number().int().min(0).max(60000).parse(busyTimeoutMs);
  if (databasePath !== ':memory:') {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    try {
      const file = await open(databasePath, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
    const app = sqliteRow.parse(db.prepare('PRAGMA application_id').get()).application_id;
    const version = sqliteRow.parse(db.prepare('PRAGMA user_version').get()).user_version;
    const empty = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0;
    const fresh = app === 0 && version === 0 && empty;
    if (!(app === APPLICATION_ID && version === SCHEMA_VERSION) && !fresh) {
      throw new EnterpriseError('storage_invalid', 'Enterprise database version or ownership is unsupported.');
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    if (fresh) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS enterprise_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
      INSERT OR IGNORE INTO enterprise_meta VALUES (1,0);
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL, stage TEXT NOT NULL, nextAction TEXT NOT NULL, nextActionDate TEXT, updatedAt TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, stock INTEGER NOT NULL CHECK(stock>=0), reorderAt INTEGER NOT NULL CHECK(reorderAt>=0), supplier TEXT NOT NULL, updatedAt TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('purchase','sale')), counterparty TEXT NOT NULL, orderDate TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','submitted')), totalMinorUnits INTEGER NOT NULL CHECK(totalMinorUnits>=0), note TEXT NOT NULL, updatedAt TEXT NOT NULL, submittedAt TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS order_lines (orderId TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, position INTEGER NOT NULL, itemId TEXT NOT NULL REFERENCES inventory(id), quantity INTEGER NOT NULL CHECK(quantity>0), unitPriceMinorUnits INTEGER NOT NULL CHECK(unitPriceMinorUnits>=0), PRIMARY KEY(orderId,itemId), UNIQUE(orderId,position)) STRICT;
      CREATE TABLE IF NOT EXISTS enterprise_audit (revision INTEGER PRIMARY KEY, commandId TEXT NOT NULL UNIQUE, type TEXT NOT NULL, entityId TEXT NOT NULL, at TEXT NOT NULL, commandJson TEXT NOT NULL CHECK(json_valid(commandJson)), beforeJson TEXT NOT NULL CHECK(json_valid(beforeJson)), afterJson TEXT NOT NULL CHECK(json_valid(afterJson))) STRICT;
      PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;
    `);
    if (sqliteRow.parse(db.prepare('PRAGMA quick_check').get()).quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new EnterpriseError('storage_invalid', 'Enterprise database integrity check failed.');
    }
    const store = new EnterpriseStore(db);
    store.snapshot();
    return store;
  } catch (error) {
    db.close();
    if (error instanceof EnterpriseError) throw error;
    throw new EnterpriseError('storage_invalid', 'Enterprise database could not be opened.');
  }
}

/** Minimal public DSH Connection Fetch registry, whose carrier owns authentication and origin checks. */
export interface EnterpriseHostContext {
  connection: { fetch: { register(route: {
    path: string; methods: readonly ('GET' | 'POST')[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void> } };
}

function errorResponse(error: unknown): Response {
  const failure = error instanceof EnterpriseError ? error
    : new EnterpriseError('storage_unavailable', 'Enterprise storage is unavailable.');
  const status = failure.code === 'invalid_request' ? 400 : failure.code === 'not_found' ? 404
    : failure.code === 'storage_invalid' || failure.code === 'storage_unavailable' ? 503 : 409;
  return Response.json({ error: {
    code: failure.code, message: failure.message,
    ...(failure.currentRevision === undefined ? {} : { currentRevision: failure.currentRevision }),
  } }, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Register routes on DSH's authenticated Fetch carrier; owns no listener.
 * @param ctx DSH Host context with the Fetch registration service.
 * @param config Persistent database location and optional writer-lock wait.
 * @returns Idempotent cleanup that removes routes, drains work and closes SQLite.
 */
export async function applyEnterpriseHost(ctx: EnterpriseHostContext, config: {
  databasePath: string;
  /** SQLite writer-lock wait, in milliseconds; 0 refuses contention immediately. */
  busyTimeoutMs?: number;
}): Promise<() => Promise<void>> {
  const store = await openEnterpriseStore(config.databasePath, config.busyTimeoutMs);
  try {
    const remove = await mountEnterpriseRoutes(ctx, store);
    return async () => { try { await remove(); } finally { store.close(); } };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Mount the browser routes over a shared enterprise store.
 * @param ctx DSH's authenticated Fetch registry.
 * @param store Database shared with other enterprise consumers.
 * @returns Idempotent route withdrawal and request drain; the caller closes the store afterward.
 */
export async function mountEnterpriseRoutes(ctx: EnterpriseHostContext, store: EnterpriseStore): Promise<() => Promise<void>> {
  const disposers: (() => Promise<void>)[] = [];
  const pending = new Set<Promise<Response>>();
  let closing = false;
  let disposing: Promise<void> | undefined;
  const handle = (operation: (request: Request) => Promise<EnterpriseSnapshot>) => (request: Request): Promise<Response> => {
    if (closing) return Promise.resolve(errorResponse(new EnterpriseError('storage_unavailable', 'Enterprise routes are closed.')));
    const response = operation(request).then(snapshot => Response.json(snapshot, {
      headers: { 'cache-control': 'no-store' },
    })).catch(errorResponse);
    pending.add(response);
    void response.finally(() => pending.delete(response));
    return response;
  };
  const dispose = () => {
    if (disposing) return disposing;
    closing = true;
    disposing = (async () => {
      const removed = await Promise.allSettled(disposers.map(async remove => remove()));
      await Promise.allSettled(pending);
      const failed = removed.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Enterprise routes could not be removed.');
    })();
    return disposing;
  };
  try {
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_SNAPSHOT_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: handle(async () => store.snapshot()),
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_BACKUP_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async request => {
        if (closing || request.signal.aborted) return errorResponse(new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.'));
        return Response.json(store.backup(), { headers: { 'cache-control': 'no-store' } });
      },
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_RESTORE_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (closing || request.signal.aborted) return errorResponse(new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.'));
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return errorResponse(new EnterpriseError('invalid_request', 'Enterprise restore requires application/json.'));
        let value: unknown;
        try { value = await request.json(); } catch { return errorResponse(new EnterpriseError('invalid_request', 'Enterprise restore JSON is malformed.')); }
        try {
          const restore = parseEnterpriseRestoreRequest(value);
          return Response.json(store.restore(restore.backup, restore.expectedRevision), { headers: { 'cache-control': 'no-store' } });
        }
        catch (error) { return errorResponse(error); }
      },
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_COMMAND_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async request => {
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new EnterpriseError('invalid_request', 'Enterprise commands require application/json.');
        }
        let value: unknown;
        try { value = await request.json(); }
        catch { throw new EnterpriseError('invalid_request', 'Enterprise command JSON is malformed.'); }
        if (closing || request.signal.aborted) throw new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.');
        return store.execute(value);
      }),
    }));
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
