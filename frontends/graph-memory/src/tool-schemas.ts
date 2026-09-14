/** DSH output schemas; protocol parsers retain refined domain validation. */
import { valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';

const text = { type: 'string', required: true } as const;
const hit = {
  type: 'object', additionalProperties: false,
  properties: {
    id: text,
    kind: { ...text, enum: ['note', 'memory', 'file', 'tag', 'stub', 'cluster'] },
    path: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    title: text, score: { type: 'number', required: true }, why: text,
    via: { type: 'string' },
  },
} as const;

/** Query evidence without unsupported JSON Schema refinement keywords. */
export const graphQueryOutput = valueSchemaSpecToJsonSchema({
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string' }, file: { type: 'string' } } },
    hits: { type: 'array', required: true, items: hit },
    related: { type: 'array', required: true, items: hit },
  },
});

/** A refresh reports counts instead of sending the complete index to the model. */
export const graphRefreshOutput = valueSchemaSpecToJsonSchema({
  type: 'object', additionalProperties: false,
  properties: {
    generatedAt: text,
    documents: { type: 'integer', required: true },
    nodes: { type: 'integer', required: true },
    edges: { type: 'integer', required: true },
  },
});
