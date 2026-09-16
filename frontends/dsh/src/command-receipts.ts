/** Authenticated command ownership survives business restore without inventing legacy actors. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionIdentity } from './governance-audit.ts';
import { EnterpriseError } from './enterprise-types.ts';

type ReceiptNamespace = 'records' | 'tasks';

/**
 * Install ownership records independently from restorable business audit.
 * @param db Database whose enclosing migration transaction owns this table.
 */
export function initializeCommandReceipts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS command_receipt_identities (
    namespace TEXT NOT NULL, organizationId TEXT NOT NULL, commandId TEXT NOT NULL,
    identityJson TEXT NOT NULL CHECK(json_valid(identityJson)), requestSha256 TEXT NOT NULL,
    PRIMARY KEY(namespace,organizationId,commandId)
  ) STRICT;`);
}

function requestSha256(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function identityJson(identity: ExecutionIdentity): string {
  return JSON.stringify({ organizationId: identity.organizationId,
    actor: { kind: identity.actor.kind, id: identity.actor.id }, principalId: identity.principalId ?? null });
}

/**
 * Bind a new receipt to its complete request and trusted principal in the write transaction.
 * Maintenance writes with unknown actors remain readable audit history without replay authority.
 * @param db Database with the active business transaction.
 * @param namespace Command owner whose identifiers are independent from other owners.
 * @param identity Authenticated actor and initiating principal.
 * @param commandId Durable command identifier.
 * @param request Validated complete command envelope.
 */
export function recordCommandReceipt(db: DatabaseSync, namespace: ReceiptNamespace, identity: ExecutionIdentity, commandId: string, request: unknown): void {
  if (identity.actor.kind === 'unknown') return;
  const inserted = db.prepare('INSERT OR IGNORE INTO command_receipt_identities(namespace,organizationId,commandId,identityJson,requestSha256) VALUES (?,?,?,?,?)')
    .run(namespace, identity.organizationId, commandId, identityJson(identity), requestSha256(request));
  if (inserted.changes !== 1) throw new EnterpriseError('command_conflict', 'Command identifier already has an authenticated owner.');
}

/**
 * Refuse another principal, a changed request, or an unowned legacy receipt.
 * @param db Database containing durable receipt ownership.
 * @param namespace Command owner whose identifiers are independent from other owners.
 * @param identity Caller whose current resource authorization was checked by the consumer.
 * @param commandId Receipt identifier already present in business history.
 * @param request Validated complete command envelope to replay.
 */
export function assertCommandReceipt(db: DatabaseSync, namespace: ReceiptNamespace, identity: ExecutionIdentity, commandId: string, request: unknown): void {
  const row = z.object({ identityJson: z.string(), requestSha256: z.string() }).optional().parse(
    db.prepare('SELECT identityJson, requestSha256 FROM command_receipt_identities WHERE namespace=? AND organizationId=? AND commandId=?')
      .get(namespace, identity.organizationId, commandId));
  if (identity.actor.kind === 'unknown' || !row || row.identityJson !== identityJson(identity) || row.requestSha256 !== requestSha256(request)) {
    throw new EnterpriseError('command_conflict', 'Command receipt does not belong to this authenticated caller and exact request.');
  }
}
