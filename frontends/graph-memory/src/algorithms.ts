/** Dependency-free parsing, graph construction and retrieval derived from the reviewed GraphRAG package. */
import { createHash } from 'node:crypto';
import type { GraphEdge, GraphNode, GraphSnapshot } from './model.ts';

export interface IndexedDocument {
  id: string;
  kind: 'note' | 'memory' | 'file';
  path: string;
  title: string;
  text: string;
  tags: string[];
  links: string[];
  hash: string;
  mtimeMs: number;
  size: number;
  meta: Record<string, unknown>;
}

const DOCUMENT_KINDS = new Set<GraphNode['kind']>(['note', 'memory', 'file']);

/** Remove Markdown code before extracting links, tags or lexical terms. */
export function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n').replace(/`[^`\n]*`/g, ' ');
}

/** CJK bigrams plus lowercase Latin and numeric words. */
export function tokenize(text: string): string[] {
  const clean = stripCode(text).toLocaleLowerCase();
  const tokens: string[] = clean.match(/[a-z0-9][a-z0-9_+.\-]{1,}/g) ?? [];
  for (const run of clean.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run);
    else for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

/** Wiki-link targets outside code. */
export function wikiLinks(text: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of stripCode(text).matchAll(pattern)) {
    const target = match[1]?.trim();
    if (target !== undefined && target !== '') links.push(target);
  }
  return links;
}

/** Content digest used for exact duplicate evidence. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeTitle(title: string): string {
  return title.toLocaleLowerCase().replace(/[\s\u3000]+/g, '').replace(/[._\-·|｜:：,，。;；!！?？()（）[\]【】'"“”‘’/\\]+/g, '');
}

function tokenCounts(document: IndexedDocument): Record<string, number> {
  const counts: Record<string, number> = {};
  const bag = `${document.title}\n${document.title}\n${document.tags.join(' ')}\n${document.text}`;
  for (const token of tokenize(bag)) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}

function resolveLinks(nodes: GraphNode[], documents: IndexedDocument[]): { edges: GraphEdge[]; stubs: GraphNode[]; unresolved: Array<{ from: string; target: string }> } {
  const titles = new Map<string, string>();
  for (const node of nodes) {
    if (!DOCUMENT_KINDS.has(node.kind) || node.path === null) continue;
    titles.set(node.title.trim().toLocaleLowerCase(), node.id);
    titles.set(node.path.split('/').at(-1)?.replace(/\.[^.]+$/, '').toLocaleLowerCase() ?? '', node.id);
  }
  const edges: GraphEdge[] = [];
  const stubs = new Map<string, GraphNode>();
  const unresolved: Array<{ from: string; target: string }> = [];
  for (const document of documents) for (const target of document.links) {
    const key = target.trim().toLocaleLowerCase();
    const base = key.split('/').at(-1)?.replace(/\.(md|markdown)$/, '') ?? key;
    const destination = titles.get(key) ?? titles.get(key.replace(/\.(md|markdown)$/, '')) ?? titles.get(base);
    if (destination !== undefined) {
      edges.push({ src: document.id, dst: destination, kind: 'links_to', weight: 1, evidence: `[[${target}]]` });
      continue;
    }
    if (/^(Y{2,4}([-/]M{1,2}([-/]D{1,2})?)?|TBD|TODO|N\/A|待定|待补)$/i.test(target)) continue;
    const id = `stub:${key}`;
    stubs.set(id, { id, kind: 'stub', path: null, title: target, fileType: null, hash: id, mtimeMs: 0, size: 0, meta: {} });
    edges.push({ src: document.id, dst: id, kind: 'links_to', weight: 0.8, evidence: `[[${target}]] → 目标尚不存在（缺口）` });
    unresolved.push({ from: document.id, target });
  }
  return { edges, stubs: [...stubs.values()], unresolved };
}

function duplicateEdges(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const exact = new Map<string, GraphNode[]>();
  const titled = new Map<string, GraphNode[]>();
  for (const node of nodes.filter(node => DOCUMENT_KINDS.has(node.kind))) {
    const same = exact.get(node.hash) ?? [];
    same.push(node);
    exact.set(node.hash, same);
    const key = normalizeTitle(node.title);
    const names = titled.get(key) ?? [];
    names.push(node);
    titled.set(key, names);
  }
  const exactPairs = new Set<string>();
  for (const [hash, group] of exact) for (let index = 1; index < group.length; index += 1) {
    const left = group[index - 1] as GraphNode;
    const right = group[index] as GraphNode;
    exactPairs.add(`${left.id}\0${right.id}`);
    edges.push({ src: left.id, dst: right.id, kind: 'duplicate_of', weight: 1, evidence: `内容完全相同（sha256 ${hash.slice(0, 8)}）：${left.path} 与 ${right.path}` });
  }
  for (const group of titled.values()) for (let index = 1; index < group.length; index += 1) {
    const left = group[index - 1] as GraphNode;
    const right = group[index] as GraphNode;
    if (exactPairs.has(`${left.id}\0${right.id}`)) continue;
    edges.push({ src: left.id, dst: right.id, kind: 'duplicate_of', weight: 0.6, evidence: `标题相同但内容不同（疑似重复条目）：${left.title} → ${left.path} 与 ${right.path}` });
  }
  return edges;
}

function similarityEdges(nodes: GraphNode[], threshold: number, topK: number): GraphEdge[] {
  const documents = nodes.filter(node => DOCUMENT_KINDS.has(node.kind));
  const df = new Map<string, number>();
  const counts = new Map<string, Record<string, number>>();
  for (const node of documents) {
    const value = node.meta['tokenCounts'] as Record<string, number>;
    counts.set(node.id, value);
    for (const token of Object.keys(value)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const vectors = new Map<string, Map<string, number>>();
  for (const node of documents) {
    const vector = new Map<string, number>();
    let norm = 0;
    for (const [token, count] of Object.entries(counts.get(node.id) ?? {})) {
      const weight = (1 + Math.log(count)) * (Math.log((1 + documents.length) / (1 + (df.get(token) ?? 0))) + 1);
      vector.set(token, weight);
      norm += weight * weight;
    }
    const divisor = Math.sqrt(norm) || 1;
    for (const [token, weight] of vector) vector.set(token, weight / divisor);
    vectors.set(node.id, vector);
  }
  const pairs: Array<{ left: GraphNode; right: GraphNode; score: number; shared: string[] }> = [];
  for (let leftIndex = 0; leftIndex < documents.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex += 1) {
    const left = documents[leftIndex] as GraphNode;
    const right = documents[rightIndex] as GraphNode;
    const a = vectors.get(left.id) as Map<string, number>;
    const b = vectors.get(right.id) as Map<string, number>;
    let score = 0;
    const shared: string[] = [];
    for (const [token, weight] of a) if (b.has(token)) { score += weight * (b.get(token) as number); shared.push(token); }
    if (score > 0) pairs.push({ left, right, score, shared });
  }
  const selected = new Set<string>();
  for (const pair of pairs) if (pair.score >= threshold) selected.add(`${pair.left.id}\0${pair.right.id}`);
  for (const node of documents) for (const pair of pairs.filter(pair => pair.left === node || pair.right === node).sort((a, b) => b.score - a.score).slice(0, topK)) selected.add(`${pair.left.id}\0${pair.right.id}`);
  return pairs.filter(pair => selected.has(`${pair.left.id}\0${pair.right.id}`)).map(pair => ({
    src: pair.left.id, dst: pair.right.id, kind: 'similar_to', weight: Number(pair.score.toFixed(4)),
    evidence: `词法相似 cos=${pair.score.toFixed(3)}；共同词：${pair.shared.slice(0, 3).join('、') || '—'}`,
  }));
}

function tagSimilarityEdges(nodes: GraphNode[]): GraphEdge[] {
  const documents = nodes.filter(node => DOCUMENT_KINDS.has(node.kind));
  const tags = new Map(documents.map(node => [node.id, new Set((node.meta['tags'] as string[] | undefined) ?? [])]));
  const frequency = new Map<string, number>();
  for (const values of tags.values()) for (const tag of values) frequency.set(tag, (frequency.get(tag) ?? 0) + 1);
  const edges: GraphEdge[] = [];
  for (let leftIndex = 0; leftIndex < documents.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex += 1) {
    const left = documents[leftIndex] as GraphNode;
    const right = documents[rightIndex] as GraphNode;
    const shared = [...(tags.get(left.id) ?? [])].filter(tag => tags.get(right.id)?.has(tag) && (frequency.get(tag) ?? documents.length) <= Math.max(1, Math.floor(documents.length * 0.3)));
    if (shared.length === 0) continue;
    const score = Math.min(1, shared.reduce((sum, tag) => sum + Math.log(1 + documents.length / (frequency.get(tag) ?? 1)), 0) / 2);
    if (score >= 0.25) edges.push({ src: left.id, dst: right.id, kind: 'similar_to', weight: Number(score.toFixed(4)), evidence: `共享稀有标签 ${shared.slice(0, 3).map(tag => `#${tag}`).join('、')}` });
  }
  return edges;
}

function coCitationEdges(nodes: GraphNode[], links: GraphEdge[]): GraphEdge[] {
  const titles = new Map(nodes.map(node => [node.id, node.title]));
  const documents = new Set(nodes.filter(node => DOCUMENT_KINDS.has(node.kind)).map(node => node.id));
  const targets = new Map<string, Set<string>>();
  for (const edge of links) {
    if (!documents.has(edge.src) || !documents.has(edge.dst) || edge.src === edge.dst) continue;
    const values = targets.get(edge.src) ?? new Set<string>();
    values.add(edge.dst);
    targets.set(edge.src, values);
  }
  const pairs = new Map<string, { score: number; citers: string[] }>();
  for (const [citer, values] of targets) {
    if (values.size < 2 || values.size > 8) continue;
    const list = [...values].sort();
    for (let left = 0; left < list.length; left += 1) for (let right = left + 1; right < list.length; right += 1) {
      const key = `${list[left]}\0${list[right]}`;
      const pair = pairs.get(key) ?? { score: 0, citers: [] };
      pair.score += 1 / list.length;
      pair.citers.push(citer);
      pairs.set(key, pair);
    }
  }
  return [...pairs].flatMap(([key, pair]) => {
    if (pair.score < 0.25) return [];
    const [src, dst] = key.split('\0') as [string, string];
    const citedBy = pair.citers.slice(0, 2).map(id => `《${titles.get(id) ?? id}》`).join('、');
    return [{ src, dst, kind: 'co_cited' as const, weight: Number(Math.min(0.8, pair.score).toFixed(4)), evidence: `共被引：${citedBy} 同时引用两篇（score=${pair.score.toFixed(2)}）` }];
  });
}

function cluster(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const documents = nodes.filter(node => DOCUMENT_KINDS.has(node.kind));
  const adjacency = new Map(documents.map(node => [node.id, new Set<string>()]));
  for (const edge of edges.filter(edge => (edge.kind === 'similar_to' && edge.weight >= 0.18) || edge.kind === 'co_cited')) {
    adjacency.get(edge.src)?.add(edge.dst);
    adjacency.get(edge.dst)?.add(edge.src);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  const topicNodes: GraphNode[] = [];
  const memberships: GraphEdge[] = [];
  for (const document of documents) {
    if (seen.has(document.id)) continue;
    const members: string[] = [];
    const queue = [document.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      members.push(id);
      for (const neighbor of adjacency.get(id) ?? []) if (!seen.has(neighbor)) queue.push(neighbor);
    }
    if (members.length < 2) continue;
    const tagCount = new Map<string, number>();
    for (const id of members) for (const tag of (byId.get(id)?.meta['tags'] as string[] | undefined) ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    const label = [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      ?? members.map(id => byId.get(id)?.title ?? id).sort((a, b) => a.length - b.length)[0] as string;
    const topicId = `cluster:${contentHash(members.sort().join('\n')).slice(0, 12)}`;
    topicNodes.push({ id: topicId, kind: 'cluster', path: null, title: label, fileType: null, hash: topicId, mtimeMs: 0, size: members.length, meta: { members } });
    for (const id of members) memberships.push({ src: id, dst: topicId, kind: 'in_cluster', weight: 1, evidence: `主题 ${label}` });
  }
  return { nodes: topicNodes, edges: memberships };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const selected = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const symmetric = ['similar_to', 'co_cited', 'duplicate_of'].includes(edge.kind);
    const ends = symmetric ? [edge.src, edge.dst].sort() : [edge.src, edge.dst];
    const key = `${ends[0]}\0${ends[1]}\0${edge.kind}`;
    const current = selected.get(key);
    if (current === undefined) selected.set(key, edge);
    else selected.set(key, {
      ...current, weight: Math.max(current.weight, edge.weight),
      evidence: current.evidence.includes(edge.evidence) ? current.evidence : `${current.evidence}；${edge.evidence}`,
    });
  }
  return [...selected.values()];
}

/** Build one atomic graph snapshot from notes and memory using the same lexical space. */
export function buildGraph(documents: IndexedDocument[], options: {
  generatedAt: string;
  sources: GraphSnapshot['sources'];
  errors?: GraphSnapshot['errors'];
  threshold?: number;
  topK?: number;
}): GraphSnapshot {
  const nodes: GraphNode[] = documents.map(document => ({
    id: document.id, kind: document.kind, path: document.path, title: document.title,
    fileType: document.path.split('.').at(-1) ?? null, hash: document.hash,
    mtimeMs: Math.round(document.mtimeMs), size: document.size,
    meta: { ...document.meta, tags: document.tags, tokenCounts: tokenCounts(document) },
  }));
  const tagNodes = new Map<string, GraphNode>();
  const tagEdges: GraphEdge[] = [];
  for (const document of documents) for (const tag of document.tags) {
    const id = `tag:${tag.toLocaleLowerCase()}`;
    tagNodes.set(id, { id, kind: 'tag', path: null, title: tag, fileType: null, hash: id, mtimeMs: 0, size: 0, meta: {} });
    tagEdges.push({ src: document.id, dst: id, kind: 'has_tag', weight: 1, evidence: `标签 #${tag}` });
  }
  nodes.push(...tagNodes.values());
  const linked = resolveLinks(nodes, documents);
  nodes.push(...linked.stubs);
  const derived = [
    ...tagEdges, ...linked.edges, ...coCitationEdges(nodes, linked.edges), ...duplicateEdges(nodes),
    ...similarityEdges(nodes, options.threshold ?? 0.18, options.topK ?? 3), ...tagSimilarityEdges(nodes),
  ];
  const uniqueEdges = dedupeEdges(derived);
  const topics = cluster(nodes, uniqueEdges);
  return {
    schemaVersion: 1, generatedAt: options.generatedAt, sources: options.sources,
    nodes: [...nodes, ...topics.nodes], edges: [...uniqueEdges, ...topics.edges],
    unresolved: linked.unresolved, errors: options.errors ?? [],
  };
}

/** Dry-run only: describe memory writes without providing an execution path. */
export function planIngest(documents: IndexedDocument[], targetRoot = ''): Array<{ title: string; bytes: number; target: string }> {
  return documents.map(document => ({ title: document.title, bytes: Buffer.byteLength(document.text), target: targetRoot === '' ? document.title : `${targetRoot}/${document.title}` }));
}

/** Classify proposed durable facts and produce reciprocal wiki-link text without writing either system. */
export function planWriteback(items: Array<{ kind: 'conclusion' | 'decision' | 'evidence' | 'preference' | 'stable_fact'; text: string }>, noteTitle: string, memoryTitle: string): Array<{ destination: 'notes' | 'memory'; text: string; reciprocalLink: string }> {
  return items.map(item => ({
    destination: ['conclusion', 'decision', 'evidence'].includes(item.kind) ? 'notes' : 'memory',
    text: item.text,
    reciprocalLink: ['conclusion', 'decision', 'evidence'].includes(item.kind) ? `[[${memoryTitle}]]` : `[[${noteTitle}]]`,
  }));
}
