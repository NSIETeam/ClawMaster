/** Atomic graph snapshots persisted through the DSH storage service. */
import type { Storage, KvUnit } from '@deepseek-ai/dsh-storage';
import { emptyGraphSnapshot, graphSnapshotSchema, indexedDocumentSchema, type GraphSnapshot, type IndexedDocument } from './model.ts';

const DOCUMENTS_TABLE = 'documents';
const descriptor = { name: 'clawmaster_graph_memory', version: 1, tables: [DOCUMENTS_TABLE], hasGlobal: true } as const;

/** The graph's only persistence owner. One global write publishes a complete replacement. */
export class GraphStore {
  private constructor(private readonly unit: KvUnit) {}

  /** Open the graph unit through a named DSH storage backend. */
  static async open(storage: Storage, backend = 'sqlite'): Promise<GraphStore> {
    const kv = storage.backend.get(backend).kv;
    if (kv === undefined) throw new Error(`Graph Memory storage backend '${backend}' has no KV support.`);
    return new GraphStore(await kv.open(descriptor));
  }

  /** Read and validate the last complete graph; a fresh medium returns an empty graph. */
  async read(): Promise<GraphSnapshot> {
    const value = (await this.unit.loadAll()).global;
    return value === null ? emptyGraphSnapshot() : graphSnapshotSchema.parse(value);
  }

  /** Read valid rebuildable source records; a damaged cache entry is reparsed on refresh. */
  async readDocuments(): Promise<IndexedDocument[]> {
    const records = (await this.unit.loadAll()).tables[DOCUMENTS_TABLE] ?? {};
    return Object.values(records).flatMap(value => {
      const parsed = indexedDocumentSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Publish the validated graph, then reconcile its optional rebuild cache. The graph remains usable if a later cache write fails. */
  async replace(snapshot: GraphSnapshot, documents?: readonly IndexedDocument[]): Promise<void> {
    await this.unit.setGlobal(graphSnapshotSchema.parse(snapshot));
    if (documents === undefined) return;
    const records = (await this.unit.loadAll()).tables[DOCUMENTS_TABLE] ?? {};
    const next = new Map(documents.map(document => [document.id, indexedDocumentSchema.parse(document)]));
    for (const key of Object.keys(records)) if (!next.has(key)) await this.unit.deleteRecord(DOCUMENTS_TABLE, key);
    for (const [key, document] of next) {
      const current = indexedDocumentSchema.safeParse(records[key]);
      if (current.success && current.data.hash === document.hash && current.data.mtimeMs === document.mtimeMs
        && current.data.size === document.size && JSON.stringify(current.data.meta) === JSON.stringify(document.meta)) continue;
      await this.unit.putRecord(DOCUMENTS_TABLE, key, document);
    }
  }

  /** Release the unit after all writes settle. */
  close(): Promise<void> {
    return this.unit.close();
  }
}
