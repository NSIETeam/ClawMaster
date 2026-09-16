/** Responsibility records survive business backup restores; local hashes detect accidental edits, not a hostile machine owner. */
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { EnterpriseError } from './enterprise-types.ts';

const sqliteRow = z.record(z.string(), z.unknown());
interface IterableStatement extends StatementSync { iterate(...parameters: Array<string | number>): IterableIterator<unknown>; }

/** Trusted caller facts resolved by the Host, never parsed from command JSON. */
export interface ExecutionIdentity {
  actor: { kind: 'local-human' | 'member' | 'agent' | 'unknown'; id: string };
  organizationId: string;
  source: 'http' | 'tool' | 'scheduler' | 'plugin' | 'migration';
  policyVersion: number;
  /** Authenticated initiating member when an agent acts on their behalf. */
  principalId?: string;
  sessionId?: string;
  callId?: string;
  approval?: { id: string; approverId: string; generation: number; revision: number };
}

/** Local desktop identity names the authenticated device operator, not an organization member. */
export const LOCAL_HTTP_IDENTITY: ExecutionIdentity = Object.freeze({
  actor: Object.freeze({ kind: 'local-human', id: 'local-operator' }),
  organizationId: 'local', source: 'http', policyVersion: 1,
});

/** Direct maintenance calls without an authenticated carrier retain an unknown actor. */
export const UNKNOWN_IDENTITY: ExecutionIdentity = Object.freeze({
  actor: Object.freeze({ kind: 'unknown', id: 'unknown' }),
  organizationId: 'local', source: 'plugin', policyVersion: 0,
});

/** Only identifiers, operation metadata and digests enter responsibility history. */
export interface ResponsibilityInput {
  identity: ExecutionIdentity;
  operation: string;
  outcome: 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'legacy';
  commandId?: string;
  entityId?: string;
  generationBefore: number;
  revisionBefore: number;
  generationAfter: number;
  revisionAfter: number;
  backupSha256?: string;
  reasonCode?: string;
}

/** A hash links the exact persisted JSON to its predecessor. */
export interface ResponsibilityRecord extends ResponsibilityInput {
  sequence: number;
  at: string;
  previousHash: string;
  hash: string;
}

/** Install independent history and import old receipts once, with explicitly unknown actors. */
export function initializeResponsibilityHistory(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS responsibility_history (
    sequence INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), hash TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS restore_receipts (
    commandId TEXT PRIMARY KEY, requestHash TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS responsibility_no_update BEFORE UPDATE ON responsibility_history
    BEGIN SELECT RAISE(ABORT, 'Responsibility history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS responsibility_no_delete BEFORE DELETE ON responsibility_history
    BEGIN SELECT RAISE(ABORT, 'Responsibility history is append-only'); END;`);
  if (db.prepare('SELECT sequence FROM responsibility_history LIMIT 1').get()) return;
  const meta = sqliteRow.parse(db.prepare('SELECT generation FROM enterprise_meta WHERE singleton=1').get());
  const generation = Number(meta.generation);
  for (const value of (db.prepare('SELECT revision, commandId, type, entityId FROM enterprise_audit ORDER BY revision') as IterableStatement).iterate()) {
    const row = sqliteRow.parse(value);
    appendResponsibility(db, { identity: { ...UNKNOWN_IDENTITY, source: 'migration' }, operation: String(row.type), outcome: 'legacy',
      commandId: String(row.commandId), entityId: String(row.entityId), generationBefore: generation, generationAfter: generation,
      revisionBefore: Number(row.revision) - 1, revisionAfter: Number(row.revision), reasonCode: 'legacy_actor_unknown' });
  }
}

/** Append inside the owning transaction so a successful mutation and its receipt commit together. */
export function appendResponsibility(db: DatabaseSync, input: ResponsibilityInput): ResponsibilityRecord {
  const previous = sqliteRow.optional().parse(db.prepare('SELECT sequence, hash FROM responsibility_history ORDER BY sequence DESC LIMIT 1').get());
  const body = { sequence: Number(previous?.sequence ?? 0) + 1, at: new Date().toISOString(), previousHash: String(previous?.hash ?? ''), ...input };
  const encoded = JSON.stringify(body);
  const hash = createHash('sha256').update(encoded).digest('hex');
  db.prepare('INSERT INTO responsibility_history(sequence, body, hash) VALUES (?, ?, ?)').run(body.sequence, encoded, hash);
  return { ...body, hash };
}

const querySchema = z.object({
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  actorId: z.string().max(128).optional(), commandId: z.string().max(128).optional(),
  entityId: z.string().max(128).optional(), operation: z.string().max(128).optional(),
}).strict();

/** Deployment-validated row and complete-response byte limits for responsibility reads. */
export interface ResponsibilityQueryLimits { maxRows: number; maxBytes: number; }

type ResponsibilityPage = { records: ResponsibilityRecord[]; nextAfter: number | null };

function responseBytes(value: ResponsibilityPage, transport: 'http' | 'tool'): number {
  const text = JSON.stringify(value);
  return Buffer.byteLength(transport === 'http' ? text : JSON.stringify({ isError: false, value, content: [{ type: 'text', text }] }), 'utf8');
}

/**
 * Read complete records within row and encoded-response budgets, continuing after the last returned sequence.
 * @param db Open responsibility database whose history is append-only.
 * @param value Optional metadata filters, exclusive after sequence and requested row limit.
 * @param limits Already validated deployment limits; omitted query limit uses maxRows.
 * @param transport HTTP JSON or DSH structured value with its JSON text rendering.
 * @returns One page; nextAfter is null when no further matching record was observed.
 * @throws EnterpriseError when the query is invalid or its first record or response metadata cannot fit.
 */
export function queryResponsibility(db: DatabaseSync, value: unknown, limits: ResponsibilityQueryLimits,
  transport: 'http' | 'tool' = 'http'): ResponsibilityPage {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) throw new EnterpriseError('invalid_request', 'Invalid responsibility history query.');
  const query = parsed.data;
  const limit = query.limit ?? limits.maxRows;
  if (limit > limits.maxRows) throw new EnterpriseError('invalid_request', 'Responsibility history row limit exceeds the configured maximum.');
  const predicates = ['sequence > ?'];
  const parameters: (string | number)[] = [query.after];
  for (const [key, path] of [['actorId', '$.identity.actor.id'], ['commandId', '$.commandId'], ['entityId', '$.entityId'], ['operation', '$.operation']] as const) {
    if (query[key] !== undefined) { predicates.push(`json_extract(body, '${path}') = ?`); parameters.push(query[key]); }
  }
  const rows = (db.prepare(`SELECT body, hash FROM responsibility_history WHERE ${predicates.join(' AND ')} ORDER BY sequence`) as IterableStatement).iterate(...parameters);
  const records: ResponsibilityRecord[] = [];
  let nextAfter: number | null = null;
  let recordBytes = 0;
  const emptyBytes = responseBytes({ records: [], nextAfter: null }, transport);
  try {
    let current = rows.next();
    while (!current.done && records.length < limit) {
      const row = sqliteRow.parse(current.value);
      const record = { ...JSON.parse(String(row.body)) as Omit<ResponsibilityRecord, 'hash'>, hash: String(row.hash) };
      const following = rows.next();
      const candidateAfter = following.done ? null : record.sequence;
      const candidateBytes = recordBytes + responseBytes({ records: [record], nextAfter: null }, transport) - emptyBytes
        + (records.length > 0 ? transport === 'http' ? 1 : 2 : 0);
      if (responseBytes({ records: [], nextAfter: candidateAfter }, transport) + candidateBytes > limits.maxBytes) {
        if (records.length === 0) throw new EnterpriseError('result_too_large', 'A responsibility record exceeds the configured response byte budget.');
        break;
      }
      records.push(record);
      recordBytes = candidateBytes;
      nextAfter = candidateAfter;
      current = following;
    }
  } finally { rows.return?.(); }
  const result = { records, nextAfter };
  if (responseBytes(result, transport) > limits.maxBytes) throw new EnterpriseError('result_too_large', 'Responsibility response metadata exceeds the configured byte budget.');
  return result;
}

/** Validate the complete hash chain without loading the business database into memory. */
export function verifyResponsibility(db: DatabaseSync): void {
  let sequence = 0;
  let previousHash = '';
  for (const value of (db.prepare('SELECT sequence, body, hash FROM responsibility_history ORDER BY sequence') as IterableStatement).iterate()) {
    const row = sqliteRow.parse(value);
    const body = JSON.parse(String(row.body)) as ResponsibilityRecord;
    if (Number(row.sequence) !== ++sequence || body.sequence !== sequence || body.previousHash !== previousHash
      || createHash('sha256').update(String(row.body)).digest('hex') !== row.hash) throw new Error('Responsibility history integrity check failed.');
    previousHash = String(row.hash);
  }
}
