/** DSH tool schemas; enterprise-schema owns domain refinements and durable validation. */
import { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';

const text = { type: 'string', required: true } as const;
const integer = { type: 'integer', required: true } as const;
const id = { ...text, description: '1–128 letters, digits, underscores or hyphens.' } as const;
const date = { ...text, description: 'Calendar date in YYYY-MM-DD format.' } as const;
const nullableDate = { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } as const;
const contact = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    id, name: text, company: text,
    stage: { ...text, enum: ['lead', 'contacted', 'proposal', 'won', 'lost'] },
    nextAction: text, nextActionDate: nullableDate,
  },
} as const;
const item = {
  type: 'object', additionalProperties: false, required: true,
  properties: { id, sku: text, name: text, stock: integer, reorderAt: integer, supplier: text },
} as const;
const order = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    id, kind: { ...text, enum: ['purchase', 'sale'] }, counterparty: text,
    orderDate: date, currency: { ...text, const: 'CNY' }, note: text,
    lines: {
      type: 'array', required: true,
      description: 'At least one distinct inventory item. Quantity is positive; price is a nonnegative integer in CNY minor units.',
      items: {
        type: 'object', additionalProperties: false,
        properties: { itemId: id, quantity: integer, unitPriceMinorUnits: integer },
      },
    },
  },
} as const;
const command = {
  required: true,
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'contact.upsert' }, contact } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'contact.remove' }, id } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'item.upsert' }, item } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'item.remove' }, id } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'order.save' }, order } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'order.remove' }, id } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'order.submit' }, id } },
  ],
} as const;

/** Exact command envelope shared with the HTTP transaction parser. */
export const enterpriseCommandParameters = {
  ...parameterSchemaSpecToJsonSchema({
    request: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        revision: { ...integer, description: 'Current enterprise revision returned by enterprise_query. Stale writes fail.' },
        commandId: { ...id, description: 'Unique idempotency key. Retry the identical request with the same key.' },
        command,
      },
    },
  }),
  additionalProperties: false,
};

/** Paginated single-collection query, with an optional revision fence across pages. */
export const enterpriseQueryParameters = {
  ...parameterSchemaSpecToJsonSchema({
    collection: { ...text, enum: ['contacts', 'inventory', 'orders', 'audit'] },
    id: { type: 'string', description: 'Exact record id; audit queries match entityId or commandId.' },
    search: { type: 'string', description: 'Case-insensitive substring of record text. Combine with id to narrow results.' },
    offset: { ...integer, description: 'Zero-based offset in the filtered results.' },
    limit: { ...integer, description: 'Requested positive page size, bounded by the configured maximum.' },
    revision: { type: 'integer', description: 'Use the previous page revision to reject a changed dataset.' },
  }),
  additionalProperties: false,
};

/** Only selected page records enter the canonical result and model transcript. */
export const enterpriseQueryOutput = valueSchemaSpecToJsonSchema({
  type: 'object', additionalProperties: false,
  properties: {
    revision: integer,
    collection: { ...text, enum: ['contacts', 'inventory', 'orders', 'audit'] },
    offset: integer, total: integer,
    nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    records: {
      type: 'array', required: true,
      description: 'Validated records from the selected collection only. Audit records include durable before/after facts.',
      items: { type: 'json' },
    },
  },
});

/** Durable command receipt; detailed records remain available through enterprise_query. */
export const enterpriseCommandOutput = valueSchemaSpecToJsonSchema({
  type: 'object', additionalProperties: false,
  properties: {
    revision: integer, commandId: id, commandRevision: integer, entityId: id,
    type: { ...text, enum: ['contact.upsert', 'contact.remove', 'item.upsert', 'item.remove', 'order.save', 'order.remove', 'order.submit'] },
    at: text,
  },
});
