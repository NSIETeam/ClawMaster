/** SQLite full-text indexes for enterprise records and their validated pages. */
import type { DatabaseSync } from 'node:sqlite';

const indexes = {
  contacts: { table: 'contacts', columns: ['id', 'name', 'company', 'stage', 'nextAction', 'nextActionDate', 'updatedAt'] },
  inventory: { table: 'inventory', columns: ['id', 'sku', 'name', 'supplier', 'updatedAt'] },
  orders: { table: 'orders', columns: ['id', 'kind', 'counterparty', 'orderDate', 'currency', 'note', 'status', 'updatedAt', 'submittedAt'] },
  audit: { table: 'enterprise_audit', columns: ['commandId', 'entityId', 'at', 'type', 'beforeJson', 'afterJson'] },
  orderLines: { table: 'order_lines', columns: ['itemId'] },
} as const;

function triggers(name: string, table: string, columns: readonly string[]): string {
  const fields = columns.join(', ');
  const oldFields = columns.map(column => `old.${column}`).join(', ');
  const newFields = columns.map(column => `new.${column}`).join(', ');
  return `CREATE TRIGGER IF NOT EXISTS ${name}_search_insert AFTER INSERT ON ${table} BEGIN
    INSERT INTO ${name}_search(rowid, ${fields}) VALUES (new.rowid, ${newFields});
  END;
  CREATE TRIGGER IF NOT EXISTS ${name}_search_delete AFTER DELETE ON ${table} BEGIN
    INSERT INTO ${name}_search(${name}_search, rowid, ${fields}) VALUES ('delete', old.rowid, ${oldFields});
  END;
  CREATE TRIGGER IF NOT EXISTS ${name}_search_update AFTER UPDATE ON ${table} BEGIN
    INSERT INTO ${name}_search(${name}_search, rowid, ${fields}) VALUES ('delete', old.rowid, ${oldFields});
    INSERT INTO ${name}_search(rowid, ${fields}) VALUES (new.rowid, ${newFields});
  END;`;
}

/**
 * Create each external-content index and its incremental record triggers.
 * @param db - Database in the owning schema-initialization transaction.
 */
export function initializeEnterpriseSearchIndexes(db: DatabaseSync): void {
  for (const [name, index] of Object.entries(indexes)) {
    const columns = index.columns.join(', ');
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${name}_search`) !== undefined;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name}_search USING fts5(${columns}, content='${index.table}', content_rowid='rowid', tokenize='trigram');`);
    db.exec(triggers(name, index.table, index.columns));
    if (!exists) db.exec(`INSERT INTO ${name}_search(${name}_search) VALUES ('rebuild');`);
  }
}

/**
 * Remove incremental triggers before bulk replacement. The caller must rebuild
 * the indexes before committing; rollback restores the previous triggers and index data.
 * @param db - Database holding the restore write transaction.
 */
export function pauseEnterpriseSearchIndexes(db: DatabaseSync): void {
  for (const name of Object.keys(indexes)) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}_search_insert; DROP TRIGGER IF EXISTS ${name}_search_delete; DROP TRIGGER IF EXISTS ${name}_search_update;`);
  }
}

/**
 * Rebuild each index from restored records and reinstate incremental triggers.
 * @param db - Database holding the same uncommitted restore transaction as the bulk replacement.
 */
export function rebuildEnterpriseSearchIndexes(db: DatabaseSync): void {
  for (const [name, index] of Object.entries(indexes)) {
    db.exec(`INSERT INTO ${name}_search(${name}_search) VALUES ('rebuild');`);
    db.exec(triggers(name, index.table, index.columns));
  }
}
