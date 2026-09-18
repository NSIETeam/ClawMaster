/** Read-only acceptance against the user's real Notes vault and configured OpenViking service. */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { NotesService } from '../../notes/src/service.ts';
import { Vault } from '../../notes/src/vault.ts';
import { Config, SqliteStorageBackend } from '../../../packages/storage/storage-sqlite/src/index.ts';
import { GraphMemoryEngine } from '../src/engine.ts';
import { indexSources } from '../src/indexer.ts';
import { GraphStore } from '../src/store.ts';

const root = process.argv[2] ?? join(homedir(), 'Documents', 'ClawMaster 笔记');
const service = new NotesService(await Vault.open(root));
const access = {
  root,
  async list() { return (await service.tree()).notes; },
  read: (id: string) => service.read(id),
};
const graph = await indexSources(access, {
  memory: 'auto', includePeerMemory: false, maxMemoryEntries: 500,
  similarityThreshold: 0.18, similarPerDocument: 3, fileSources: [],
});
const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-graph-memory-real-'));
const database = join(temporary, 'graph.sqlite');
const backend = new SqliteStorageBackend(new Config({ path: database }));
const store = await GraphStore.open({ backend: { get(name: string) { if (name !== 'sqlite') throw new Error(`Unexpected backend ${name}`); return backend; } } } as never);
await store.replace(graph);
const engine = new GraphMemoryEngine(store);
let primaryOpen = true;
let reopenedStore: GraphStore | undefined;
let reopenedBackend: SqliteStorageBackend | undefined;
try {
  const candidates = ['ClawMaster', '笔记 记忆', 'OpenViking', '项目'];
  let accepted: { query: string; kinds: string[]; evidence: number } | undefined;
  for (const query of candidates) {
    const result = await engine.query({ query, limit: 25, hops: 2 });
    const kinds = [...new Set([...result.hits, ...result.related].map(hit => hit.kind))].sort();
    if (kinds.includes('note') && kinds.includes('memory')) {
      accepted = { query, kinds, evidence: [...result.hits, ...result.related].filter(hit => hit.why.trim() !== '').length };
      break;
    }
  }
  const notes = graph.nodes.filter(node => node.kind === 'note').length;
  const memories = graph.nodes.filter(node => node.kind === 'memory').length;
  if (notes === 0) throw new Error('Real-vault acceptance found no notes.');
  if (memories === 0) throw new Error(`Real-vault acceptance found no memories: ${graph.errors.map(error => error.message).join('; ')}`);
  if (accepted === undefined) throw new Error('No acceptance query recalled both notes and memory through one ranking path.');
  await engine.close();
  primaryOpen = false;
  await backend.close();
  reopenedBackend = new SqliteStorageBackend(new Config({ path: database }));
  reopenedStore = await GraphStore.open({ backend: { get() { return reopenedBackend as SqliteStorageBackend; } } } as never);
  const persisted = await reopenedStore.read();
  console.log(JSON.stringify({
    notes, memories, nodes: persisted.nodes.length, edges: persisted.edges.length,
    topics: persisted.nodes.filter(node => node.kind === 'cluster').length,
    duplicateAnnotations: persisted.edges.filter(edge => edge.kind === 'duplicate_of').length,
    unresolved: persisted.unresolved.length, sourceErrors: persisted.errors.length,
    sqliteBytes: (await stat(database)).size, unifiedQuery: accepted,
  }, null, 2));
} finally {
  if (primaryOpen) await engine.close();
  await reopenedStore?.close();
  await reopenedBackend?.close();
  await backend.close();
  await rm(temporary, { recursive: true, force: true });
}
