/** Browser-safe envelopes for file-based backup preparation and restore receipts. */
import { z } from 'zod';
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Counts and digest shown before the operator confirms replacement. */
export const preparedBackupSchema = z.object({ token: identifier, backupSha256: digest, exportedAt: z.string().datetime(),
  generation: integer, revision: integer,
  counts: z.object({ contacts: integer, inventory: integer, orders: integer, audit: integer }).strict(),
}).strict();
/** Review metadata contains no business records. */
export type PreparedEnterpriseBackup = z.output<typeof preparedBackupSchema>;
/** An exact retry retains this complete envelope, including its command identifier. */
export const restoreBackupRequestSchema = z.object({ token: identifier, backupSha256: digest,
  expectedGeneration: integer, expectedRevision: integer, commandId: identifier, confirm: z.literal(true),
}).strict();
/** Confirmed replacement of one previously reviewed database version. */
export type RestoreBackupRequest = z.output<typeof restoreBackupRequestSchema>;
/** Persisted restore result; unaffected by subsequent ordinary writes. */
export const restoreBackupReceiptSchema = z.object({ commandId: identifier, backupSha256: digest, generation: integer, revision: integer }).strict();
/** Small durable acknowledgement of a completed restore. */
export type RestoreBackupReceipt = z.output<typeof restoreBackupReceiptSchema>;
/** Raw JSON uploads are bounded before parsing. */
export const ENTERPRISE_BACKUP_PREPARE_PATH = '/api/clawmaster/enterprise/backup/prepare';
