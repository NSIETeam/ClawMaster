/** Atomic graph snapshots persisted through the DSH storage service. */
import type { Storage, KvUnit } from '@deepseek-ai/dsh-storage';
import { emptyGraphSnapshot, graphSnapshotSchema, type GraphSnapshot } from './model.ts';

const descriptor = { name: 'clawmaster_graph_memory', version: 1, tables: [], hasGlobal: true } as const;

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

  /** Atomically replace the durable graph after validating every record. */
  async replace(snapshot: GraphSnapshot): Promise<void> {
    await this.unit.setGlobal(graphSnapshotSchema.parse(snapshot));
  }

  /** Release the unit after all writes settle. */
  close(): Promise<void> {
    return this.unit.close();
  }
}
