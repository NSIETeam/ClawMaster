/** DSH's enforced schema subset; taskRequestSchema owns text limits, dates and transition refinements. */
import { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';

const text = { type: 'string', required: true } as const;
const integer = { type: 'integer', required: true } as const;
const listCursor = { type: 'object', additionalProperties: false, properties: { version: integer, offset: integer, asOf: text } } as const;
const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } as const;
const strings = { type: 'array', required: true, items: { type: 'string' } } as const;
const taskFields = {
  goal: text, scope: text, dueAt: nullableText, timezone: text, risk: { ...text, enum: ['low', 'medium', 'high'] },
  owner: { required: true, oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'local' }, label: text } },
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'member' }, id: text } },
  ] },
  checklist: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: text, description: text } } },
} as const;
const definition = { type: 'object', additionalProperties: false, required: true, properties: taskFields } as const;
const evidence = { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
  properties: { id: text, location: text, observedAt: text, summary: text } } } as const;
const task = { type: 'object', additionalProperties: false, properties: { ...taskFields,
  id: text, organizationId: text, revision: integer, status: { ...text, enum: ['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled'] },
  createdAt: text, updatedAt: text, source: { ...text, enum: ['new', 'imported-session'] }, sessionIds: strings,
  waitingFor: nullableText, evidence, completedCriteria: strings, submittedBy: nullableText,
  lastReview: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
    properties: { actorId: text, decision: { ...text, enum: ['accept', 'reject'] }, comment: text, at: text } }] },
} } as const;

/** Exact task mutation envelope; no authority fields are accepted from the model. */
export const taskCommandParameters = { ...parameterSchemaSpecToJsonSchema({ id: text, commandId: text, revision: integer,
  command: { required: true, oneOf: [
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'create' }, task: definition, importedSessionId: { type: 'string' } } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'revise' }, task: definition } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'queue' } } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'start' }, sessionId: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'link' }, sessionId: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'wait' }, reason: nullableText } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'fail' }, reason: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'submit' }, evidence, completedCriteria: strings } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'review' }, decision: { ...text, enum: ['accept', 'reject'] }, comment: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'reopen' }, reason: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'cancel' }, reason: text } },
  ] },
}), additionalProperties: false };

/** Bounded lookup arguments accepted by HTTP and the model tool. */
export const taskQueryParameters = { ...parameterSchemaSpecToJsonSchema({
  id: { type: 'string' }, cursor: listCursor, after: { type: 'integer' }, limit: { type: 'integer' }, history: { type: 'boolean' },
}), additionalProperties: false };
/** A committed task includes its business state and reviewed evidence. */
export const taskCommandOutput = valueSchemaSpecToJsonSchema(task);
/** Lookup returns one task or a complete-record page with its continuation cursor. */
export const taskQueryOutput = valueSchemaSpecToJsonSchema({ oneOf: [task,
  { type: 'object', additionalProperties: false, properties: { tasks: { type: 'array', required: true, items: task },
    nextAfter: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] } } },
  { type: 'object', additionalProperties: false, properties: { tasks: { type: 'array', required: true, items: task },
    nextCursor: { required: true, oneOf: [listCursor, { type: 'null' }] } } },
] });
