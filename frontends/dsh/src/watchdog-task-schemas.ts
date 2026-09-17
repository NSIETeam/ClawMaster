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
const capsuleScope = { required: true, oneOf: [
  { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'user' } } },
  { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'project' }, id: text } },
  { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'session' }, id: text } },
] } as const;
const capsuleData = { type: 'object', required: true, additionalProperties: false, properties: {
  decisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { id: text, decision: text, rationale: text, recordedAt: text } } },
  fileHashes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { path: text, sha256: text, observedAt: text } } },
  verificationResults: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { id: text, status: { ...text, enum: ['passed', 'failed', 'blocked', 'pending'] }, summary: text, verifiedAt: text } } },
  unfinishedActions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { id: text, description: text, status: { ...text, enum: ['pending', 'in_progress', 'blocked'] }, ownerId: { type: 'string' } } } },
  memoryIds: strings,
} } as const;
const stateCapsules = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
  ownerId: text,
  target: text,
  approvalState: { type: 'object', required: true, additionalProperties: false, properties: {
    status: { ...text, enum: ['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled'] },
    lastReview: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      properties: { actorId: text, decision: { ...text, enum: ['accept', 'reject'] }, comment: text, at: text } }] },
  } },
  scope: { required: true, oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'user' }, id: text } },
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'project' }, id: text } },
    { type: 'object', additionalProperties: false, properties: { kind: { ...text, const: 'session' }, id: text } },
  ] },
  data: capsuleData, updatedAt: text,
} } } as const;
const task = { type: 'object', additionalProperties: false, properties: { ...taskFields,
  id: text, organizationId: text, revision: integer, status: { ...text, enum: ['draft', 'ready', 'in_progress', 'awaiting_review', 'accepted', 'failed', 'cancelled'] },
  createdAt: text, updatedAt: text, source: { ...text, enum: ['new', 'imported-session'] }, sessionIds: strings,
  execution: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { sessionId: text, requestId: text, locale: { type: 'string', enum: ['zh-CN', 'en-US'] }, commandId: { type: 'string' } } }] },
  waitingFor: nullableText, evidence, stateCapsules, completedCriteria: strings, submittedBy: nullableText,
  lastReview: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
    properties: { actorId: text, decision: { ...text, enum: ['accept', 'reject'] }, comment: text, at: text } }] },
} } as const;

/** Exact task mutation envelope; no authority fields are accepted from the model. */
export const taskCommandParameters = { ...parameterSchemaSpecToJsonSchema({ id: text, commandId: text, revision: integer,
  command: { required: true, oneOf: [
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'create' }, task: definition, importedSessionId: { type: 'string' } } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'revise' }, task: definition } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'queue' } } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'start' }, sessionId: text, requestId: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'link' }, sessionId: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'wait' }, reason: nullableText } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'fail' }, reason: text } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'submit' }, evidence, completedCriteria: strings } },
    { type: 'object', additionalProperties: false, properties: { type: { ...text, const: 'capsule' }, scope: capsuleScope, data: capsuleData } },
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
