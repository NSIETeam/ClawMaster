/** Direct in-process graph reads over one durable snapshot. */
import { graphQuerySchema, type GraphQuery, type GraphQueryResult } from './protocol.ts';
import type { GraphEdge, GraphNode, GraphSnapshot } from './model.ts';
import { GraphStore } from './store.ts';
import { tokenize } from './algorithms.ts';

const DOCUMENT_KINDS = new Set<GraphNode['kind']>(['note', 'memory', 'file']);
const STOP_WORDS = new Set(['的', '了', '是', '在', '和', '与', '就', '都', '而', '及', '或', '被', '把', '对', '为', '以', '这', '那', 'to', 'of', 'the', 'and', 'for', 'is']);

/** Read/query facade shared by Fetch routes, tools and the context bridge. */
export class GraphMemoryEngine {
  constructor(private readonly store: GraphStore) {}

  /** Return the last complete snapshot. */
  graph(): Promise<GraphSnapshot> {
    return this.store.read();
  }

  /** Query the snapshot directly; no subprocess or shell bridge is involved. */
  async query(input: GraphQuery): Promise<GraphQueryResult> {
    const request = graphQuerySchema.parse(input);
    const graph = await this.store.read();
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const wanted = request.file?.toLocaleLowerCase();
    const terms = [...new Set(tokenize(request.query ?? ''))].filter(term => !STOP_WORDS.has(term));
    const documents = graph.nodes.filter(node => DOCUMENT_KINDS.has(node.kind));
    const documentFrequency = new Map<string, number>();
    const lengths = new Map<string, number>();
    for (const node of documents) {
      const counts = node.meta['tokenCounts'] as Record<string, number> | undefined ?? {};
      lengths.set(node.id, Object.values(counts).reduce((sum, count) => sum + count, 0));
      for (const term of Object.keys(counts)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    const averageLength = [...lengths.values()].reduce((sum, length) => sum + length, 0) / (lengths.size || 1) || 1;
    const scored = graph.nodes.flatMap(node => {
      if (!DOCUMENT_KINDS.has(node.kind)) return [];
      if (wanted !== undefined) return node.path?.toLocaleLowerCase() === wanted
        ? [{ node, score: 1, why: '指定文件' }] : [];
      const counts = node.meta['tokenCounts'] as Record<string, number> | undefined ?? {};
      const contributions = terms.flatMap(term => {
        const frequency = counts[term] ?? 0;
        if (frequency === 0) return [];
        const documentCount = documentFrequency.get(term) ?? 0;
        const inverse = Math.log((documents.length - documentCount + 0.5) / (documentCount + 0.5) + 1);
        const normal = 1.2 * (0.25 + 0.75 * ((lengths.get(node.id) ?? averageLength) / averageLength));
        return [{ term, score: inverse * ((frequency * 2.2) / (frequency + normal)) }];
      });
      const score = contributions.reduce((sum, contribution) => sum + contribution.score, 0);
      return score === 0 ? [] : [{
        node, score: Number(score.toFixed(4)),
        why: `命中：${contributions.sort((left, right) => right.score - left.score).slice(0, 4).map(item => `${item.term}(${item.score.toFixed(2)})`).join('、')}`,
      }];
    }).sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
    const duplicateById = new Map<string, { other: string; exact: boolean }>();
    for (const edge of graph.edges.filter(edge => edge.kind === 'duplicate_of')) {
      duplicateById.set(edge.src, { other: edge.dst, exact: edge.weight === 1 });
      duplicateById.set(edge.dst, { other: edge.src, exact: edge.weight === 1 });
    }
    const hits: GraphQueryResult['hits'] = [];
    const retained = new Set<string>();
    for (const { node, score, why } of scored) {
      const duplicate = duplicateById.get(node.id);
      if (duplicate?.exact === true && retained.has(duplicate.other)) {
        const owner = hits.find(hit => hit.id === duplicate.other);
        if (owner !== undefined) owner.why += `；已折叠重复副本 ${node.path ?? node.id}`;
        continue;
      }
      const sameTitle = duplicate === undefined ? '' : ` · ${duplicate.exact ? '另有完全相同副本' : '另有同标题条目'}：${byId.get(duplicate.other)?.path ?? duplicate.other}`;
      hits.push({ id: node.id, kind: node.kind, path: node.path, title: node.title, score, why: `${why}${sameTitle}` });
      retained.add(node.id);
      if (hits.length >= request.limit) break;
    }
    const seen = new Set(hits.map(hit => hit.id));
    const related: GraphQueryResult['related'] = [];
    let frontier = hits.map(hit => ({ id: hit.id, score: hit.score }));
    for (let hop = 1; hop <= request.hops; hop += 1) {
      const next: Array<{ id: string; score: number }> = [];
      for (const parent of frontier) for (const edge of graph.edges) {
        if (edge.src !== parent.id && edge.dst !== parent.id) continue;
        const otherId = edge.src === parent.id ? edge.dst : edge.src;
        const node = byId.get(otherId);
        if (node === undefined || seen.has(node.id)) continue;
        seen.add(node.id);
        const score = Number((Math.min(1, parent.score) * (0.5 ** hop) * (0.5 + 0.5 * edge.weight)).toFixed(4));
        if (DOCUMENT_KINDS.has(node.kind)) {
          related.push({ id: node.id, kind: node.kind, path: node.path, title: node.title, score, why: edge.evidence, via: `${parent.id} --${edge.kind}(${edge.weight})--> ${node.id}` });
          next.push({ id: node.id, score });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    related.sort((left, right) => right.score - left.score).splice(request.limit);
    return {
      query: wanted === undefined ? { text: request.query as string } : { file: request.file as string },
      hits,
      related,
    };
  }

  /** Publish a fully built graph from the in-process indexer. */
  async replace(snapshot: GraphSnapshot): Promise<GraphSnapshot> {
    await this.store.replace(snapshot);
    return snapshot;
  }

  /** Release the storage unit. */
  close(): Promise<void> {
    return this.store.close();
  }
}

/** Related documents and topic nodes for the panel. */
export function panelProjection(graph: GraphSnapshot): {
  graph: GraphSnapshot;
  themes: GraphNode[];
  similar: Record<string, Array<{ edge: GraphEdge; node: GraphNode }>>;
} {
  const publicNodes = graph.nodes.map(node => ({
    ...node,
    meta: Object.fromEntries(Object.entries(node.meta).filter(([key]) => key !== 'content' && key !== 'tokenCounts')),
  }));
  const publicGraph = { ...graph, nodes: publicNodes };
  const byId = new Map(publicNodes.map(node => [node.id, node]));
  const similar: Record<string, Array<{ edge: GraphEdge; node: GraphNode }>> = {};
  for (const edge of graph.edges) {
    if (!['similar_to', 'co_cited', 'duplicate_of'].includes(edge.kind)) continue;
    for (const [from, to] of [[edge.src, edge.dst], [edge.dst, edge.src]] as const) {
      const node = byId.get(to);
      if (node === undefined) continue;
      (similar[from] ??= []).push({ edge, node });
    }
  }
  for (const rows of Object.values(similar)) rows.sort((left, right) => right.edge.weight - left.edge.weight);
  return { graph: publicGraph, themes: publicNodes.filter(node => node.kind === 'cluster'), similar };
}
