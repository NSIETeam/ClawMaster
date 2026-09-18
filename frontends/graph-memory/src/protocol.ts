/** Validated route and tool contracts for Graph Memory. */
import { z } from 'zod';
import { graphEdgeSchema, graphNodeSchema, graphSnapshotSchema } from './model.ts';

export const GRAPH_MEMORY_GRAPH_PATH = '/api/clawmaster/graph-memory/graph';
export const GRAPH_MEMORY_QUERY_PATH = '/api/clawmaster/graph-memory/query';
export const GRAPH_MEMORY_REFRESH_PATH = '/api/clawmaster/graph-memory/refresh';

export const graphQuerySchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  file: z.string().trim().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(25).default(10),
  hops: z.number().int().min(0).max(3).default(1),
}).strict().refine(value => value.query !== undefined || value.file !== undefined, {
  message: 'Provide query or file.',
});

export const graphRefreshSchema = z.object({
  semantic: z.boolean().default(false),
}).strict();

export const graphWritebackPlanSchema = z.object({
  noteTitle: z.string().trim().min(1).max(200),
  memoryTitle: z.string().trim().min(1).max(200),
  items: z.array(z.object({
    kind: z.enum(['conclusion', 'decision', 'evidence', 'preference', 'stable_fact']),
    text: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(20),
}).strict();

export const graphWritebackPlanResultSchema = z.array(z.object({
  destination: z.enum(['notes', 'memory']), text: z.string(), reciprocalLink: z.string(),
}).strict());

export const graphHitSchema = graphNodeSchema.pick({ id: true, kind: true, path: true, title: true }).extend({
  score: z.number(),
  why: z.string(),
  via: z.string().optional(),
}).strict();

export const graphQueryResultSchema = z.object({
  query: z.object({ text: z.string().optional(), file: z.string().optional() }).strict(),
  hits: z.array(graphHitSchema),
  related: z.array(graphHitSchema),
}).strict();

export const graphPanelSchema = z.object({
  graph: graphSnapshotSchema,
  themes: z.array(graphNodeSchema),
  similar: z.record(z.string(), z.array(z.object({ edge: graphEdgeSchema, node: graphNodeSchema }).strict())),
}).strict();

export type GraphQuery = z.input<typeof graphQuerySchema>;
export type GraphQueryResult = z.infer<typeof graphQueryResultSchema>;
