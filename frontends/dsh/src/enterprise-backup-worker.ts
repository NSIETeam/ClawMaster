/** Private worker: streams exports and holds an import transaction until the Host rechecks authority. */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { enterpriseCollections } from './enterprise-host.ts';
import { parseOwnedEnterpriseBackup } from './enterprise-schema.ts';
import { EnterpriseError, type EnterpriseBackup } from './enterprise-types.ts';
import { appendResponsibility } from './governance-audit.ts';
import { enterpriseBackupConfigSchema } from './enterprise-backup-config.ts';
import { restoreBackupRequestSchema } from './enterprise-backup-format.ts';

interface IterableStatement extends StatementSync { iterate(): IterableIterator<Record<string, unknown>>; }
const messageSchema = z.object({ mode: z.enum(['export', 'prepare', 'restore']), file: z.string(), database: z.string().optional(),
  limits: enterpriseBackupConfigSchema, restore: restoreBackupRequestSchema.optional() }).strict();
if (!process.send) throw new Error('Backup executors require a private IPC channel.');
process.on('disconnect', () => process.exit(1));
const send = (message: unknown) => process.send!(message as object);
const next = (): Promise<unknown> => new Promise(resolve => process.once('message', resolve));
send({ phase: 'ready' });
const data = messageSchema.parse(await next());
const identitySchema = z.object({ actor: z.object({ kind: z.enum(['local-human', 'member', 'agent', 'unknown']), id: z.string() }).strict(),
  organizationId: z.string(), source: z.enum(['http', 'tool', 'scheduler', 'plugin', 'migration']), policyVersion: z.number().int().nonnegative(),
  principalId: z.string().optional(), sessionId: z.string().optional(), callId: z.string().optional(),
  approval: z.object({ id: z.string(), approverId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const rowSchema = z.record(z.string(), z.unknown());

function* backupChunks(backup: EnterpriseBackup): Generator<string> {
  yield `{"schemaVersion":1,"exportedAt":${JSON.stringify(backup.exportedAt)},"snapshot":{"generation":${backup.snapshot.generation},"revision":${backup.snapshot.revision}`;
  for (const key of ['contacts', 'inventory', 'orders', 'audit'] as const) {
    yield `,"${key}":[`;
    let first = true;
    for (const row of backup.snapshot[key]) { yield `${first ? '' : ','}${JSON.stringify(row)}`; first = false; }
    yield ']';
  }
  yield '},"auditCommands":[';
  let first = true;
  for (const row of backup.auditCommands) { yield `${first ? '' : ','}${JSON.stringify(row)}`; first = false; }
  yield ']}';
}
function summary(backup: EnterpriseBackup) {
  const hash = createHash('sha256');
  for (const chunk of backupChunks(backup)) hash.update(chunk);
  return { backupSha256: hash.digest('hex'), exportedAt: backup.exportedAt, generation: backup.snapshot.generation, revision: backup.snapshot.revision,
    counts: Object.fromEntries(['contacts', 'inventory', 'orders', 'audit'].map(key => [key, backup.snapshot[key as 'contacts'].length])) };
}
function exportFile(database: string): unknown {
  const db = new DatabaseSync(database, { readOnly: true } as ConstructorParameters<typeof DatabaseSync>[1]);
  const file = openSync(data.file, 'wx', 0o600);
  let bytes = 0;
  let buffer = '';
  const hash = createHash('sha256');
  const flush = () => {
    const bytes = Buffer.from(buffer); let offset = 0;
    while (offset < bytes.length) offset += writeSync(file, bytes, offset);
    buffer = '';
  };
  const write = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > data.limits.maxFileBytes) throw new EnterpriseError('result_too_large', 'Backup exceeds the configured file byte limit.');
    hash.update(text); buffer += text;
    if (Buffer.byteLength(buffer) >= data.limits.chunkBytes) { flush(); }
  };
  try {
    db.exec(`PRAGMA cache_size=-${data.limits.sqliteCacheKiB}; BEGIN;`);
    const meta = rowSchema.parse(db.prepare('SELECT generation, revision FROM enterprise_meta WHERE singleton=1').get());
    if (db.prepare('SELECT 1 FROM order_lines l LEFT JOIN inventory i ON i.id=l.itemId WHERE i.id IS NULL LIMIT 1').get()) throw new EnterpriseError('storage_invalid', 'Orders reference missing inventory.');
    const exportedAt = new Date().toISOString();
    write(`{"schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt)},"snapshot":{"generation":${meta.generation},"revision":${meta.revision}`);
    const counts: Record<string, number> = {};
    for (const key of ['contacts', 'inventory', 'orders', 'audit'] as const) {
      const collection = enterpriseCollections[key];
      write(`,"${key}":[`); let count = 0;
      for (const row of (db.prepare(`SELECT ${collection.json} AS recordJson FROM ${collection.table} r ORDER BY ${collection.order}`) as IterableStatement).iterate()) {
        const record = collection.schema.parse(JSON.parse(String(row.recordJson)));
        if (key === 'audit' && (!('revision' in record) || record.revision !== Number(meta.revision) - count)) throw new EnterpriseError('storage_invalid', 'Audit history is not contiguous.');
        write(`${count ? ',' : ''}${JSON.stringify(record)}`); count++;
      }
      counts[key] = count; write(']');
    }
    if (counts.audit !== meta.revision) throw new EnterpriseError('storage_invalid', 'Audit history is incomplete.');
    write('},"auditCommands":['); let first = true;
    for (const row of (db.prepare('SELECT revision, commandId, commandJson FROM enterprise_audit ORDER BY revision') as IterableStatement).iterate()) {
      write(`${first ? '' : ','}${JSON.stringify(row)}`); first = false;
    }
    write(']}'); if (buffer) flush();
    db.exec('COMMIT');
    return { backupSha256: hash.digest('hex'), bytes, exportedAt, ...meta, counts };
  } finally { closeSync(file); db.close(); }
}
async function restore(backup: EnterpriseBackup): Promise<unknown> {
  const request = data.restore!;
  const details = summary(backup);
  if (details.backupSha256 !== request.backupSha256) throw new EnterpriseError('storage_invalid', 'Prepared backup digest changed.');
  send({ phase: 'validated' });
  // The parent supplies a write target only after consuming the exact approval.
  const grant = z.object({ phase: z.literal('apply'), database: z.string(), identity: identitySchema }).strict().parse(await next());
  const db = new DatabaseSync(grant.database);
  let transaction = false;
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA cache_size=-${data.limits.sqliteCacheKiB}; BEGIN IMMEDIATE;`); transaction = true;
    const before = rowSchema.parse(db.prepare('SELECT generation, revision FROM enterprise_meta WHERE singleton=1').get());
    if (before.generation !== request.expectedGeneration || before.revision !== request.expectedRevision) throw new EnterpriseError('revision_conflict', 'Enterprise data changed before restore.');
    if (!Number.isSafeInteger(request.expectedGeneration + 1)) throw new EnterpriseError('numeric_overflow', 'Restore generation exceeds the integer limit.');
    db.exec('DELETE FROM order_lines; DELETE FROM orders; DELETE FROM contacts; DELETE FROM inventory; DELETE FROM enterprise_audit;');
    const insertContact = db.prepare('INSERT INTO contacts(id,name,company,stage,nextAction,nextActionDate,updatedAt) VALUES(?,?,?,?,?,?,?)');
    for (const row of backup.snapshot.contacts) insertContact.run(row.id,row.name,row.company,row.stage,row.nextAction,row.nextActionDate,row.updatedAt);
    const insertItem = db.prepare('INSERT INTO inventory(id,sku,name,stock,reorderAt,supplier,updatedAt) VALUES(?,?,?,?,?,?,?)');
    for (const row of backup.snapshot.inventory) insertItem.run(row.id,row.sku,row.name,row.stock,row.reorderAt,row.supplier,row.updatedAt);
    const insertOrder = db.prepare('INSERT INTO orders(id,kind,counterparty,orderDate,currency,status,totalMinorUnits,note,updatedAt,submittedAt) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const insertLine = db.prepare('INSERT INTO order_lines(orderId,position,itemId,quantity,unitPriceMinorUnits) VALUES(?,?,?,?,?)');
    for (const row of backup.snapshot.orders) {
      insertOrder.run(row.id,row.kind,row.counterparty,row.orderDate,row.currency,row.status,row.totalMinorUnits,row.note,row.updatedAt,row.submittedAt);
      row.lines.forEach((line,index) => insertLine.run(row.id,index,line.itemId,line.quantity,line.unitPriceMinorUnits));
    }
    const commands = new Map(backup.auditCommands.map(row => [row.revision,row.commandJson]));
    const insertAudit = db.prepare('INSERT INTO enterprise_audit(revision,commandId,type,entityId,at,commandJson,beforeJson,afterJson) VALUES(?,?,?,?,?,?,?,?)');
    for (let index = backup.snapshot.audit.length - 1; index >= 0; index--) {
      const row = backup.snapshot.audit[index]!;
      insertAudit.run(row.revision,row.commandId,row.type,row.entityId,row.at,commands.get(row.revision)!,JSON.stringify(row.before),JSON.stringify(row.after));
    }
    const result = { commandId: request.commandId, backupSha256: request.backupSha256, generation: request.expectedGeneration + 1, revision: backup.snapshot.revision };
    db.prepare('UPDATE enterprise_meta SET generation=?,revision=? WHERE singleton=1').run(result.generation,result.revision);
    const requestHash = createHash('sha256').update(JSON.stringify({ backupSha256: request.backupSha256, expectedGeneration: request.expectedGeneration,
      expectedRevision: request.expectedRevision, actor: grant.identity.actor, organizationId: grant.identity.organizationId, principalId: grant.identity.principalId ?? null })).digest('hex');
    db.prepare('INSERT INTO restore_receipts(commandId,requestHash,generation,revision) VALUES(?,?,?,?)').run(result.commandId,requestHash,result.generation,result.revision);
    send({ phase: 'commitReady' });
    const final = z.object({ phase: z.literal('finalize'), identity: identitySchema }).strict().parse(await next());
    const owner = (identity: z.infer<typeof identitySchema>) => JSON.stringify([identity.organizationId, identity.actor, identity.principalId ?? null, identity.approval ?? null]);
    if (owner(final.identity) !== owner(grant.identity)) throw new EnterpriseError('storage_invalid', 'Restore commit authority changed.');
    appendResponsibility(db, { identity: final.identity, operation: 'backup.restore', outcome: 'succeeded', commandId: result.commandId, backupSha256: result.backupSha256,
      generationBefore: request.expectedGeneration, revisionBefore: request.expectedRevision, generationAfter: result.generation, revisionAfter: result.revision });
    db.exec('COMMIT'); transaction = false;
    return result;
  } finally { if (transaction) db.exec('ROLLBACK'); db.close(); }
}
try {
  let result: unknown;
  if (data.mode === 'export') result = exportFile(z.string().parse(data.database));
  else {
    const backup = parseOwnedEnterpriseBackup(JSON.parse(readFileSync(data.file, 'utf8')));
    result = data.mode === 'prepare' ? summary(backup) : await restore(backup);
  }
  send({ phase: 'done', result, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
} catch (error) {
  send({ phase: 'error', code: error instanceof EnterpriseError ? error.code : 'storage_invalid' });
} finally { process.removeAllListeners('disconnect'); process.disconnect(); }
