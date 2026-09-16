/** Host configuration bounds for backup files, worker heaps, and prepared imports. */
import { z } from 'zod';
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Deployment choices for explicit backup and restore operations. */
export const enterpriseBackupConfigSchema = z.object({
  maxFileBytes: positive.default(67108864),
  workerHeapMb: positive.min(32).default(192),
  workerYoungHeapMb: positive.min(1).default(4),
  timeoutMs: positive.default(60000),
  preparedTtlMs: positive.default(300000),
  maxPreparedFiles: positive.default(1),
  maxConcurrentJobs: positive.default(1),
  chunkBytes: positive.max(1048576).default(65536),
  sqliteCacheKiB: positive.default(4096),
}).strict();
/** Optional values are resolved and validated when the frontend mounts. */
export type EnterpriseBackupConfig = z.input<typeof enterpriseBackupConfigSchema>;
/** Fully resolved resource limits passed to workers. */
export type EnterpriseBackupLimits = z.output<typeof enterpriseBackupConfigSchema>;
