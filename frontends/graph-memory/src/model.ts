/** Durable, JSON-safe records shared by indexing, retrieval, routes and the panel. */
import { z } from 'zod';

export const graphNodeKindSchema = z.enum(['note', 'memory', 'file', 'tag', 'stub', 'cluster']);

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  kind: graphNodeKindSchema,
  path: z.string().nullable(),
  title: z.string(),
  fileType: z.string().nullable(),
  hash: z.string(),
  mtimeMs: z.number().int(),
  size: z.number().int().nonnegative(),
  meta: z.record(z.string(), z.unknown()),
}).strict();

export const graphEdgeSchema = z.object({
  src: z.string().min(1),
  dst: z.string().min(1),
  kind: z.enum(['links_to', 'has_tag', 'similar_to', 'derived_from', 'co_cited', 'duplicate_of', 'in_cluster']),
  weight: z.number().finite(),
  evidence: z.string().min(1),
}).strict();

export const graphSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['notes', 'memory', 'files']),
  label: z.string().min(1),
  location: z.string().min(1),
  documents: z.number().int().nonnegative(),
}).strict();

export const graphSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  sources: z.array(graphSourceSchema),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  unresolved: z.array(z.object({ from: z.string(), target: z.string() }).strict()),
  errors: z.array(z.object({ source: z.string(), message: z.string() }).strict()),
}).strict();

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>;

/** Empty state before the first successful refresh. */
export function emptyGraphSnapshot(): GraphSnapshot {
  return { schemaVersion: 1, generatedAt: '', sources: [], nodes: [], edges: [], unresolved: [], errors: [] };
}
