import {
  ACTOR_VALUES,
  APPROVAL_DECISION_VALUES,
  ERROR_CODE_VALUES,
  RUNTIME_EVENT_TYPES,
  RUNTIME_EVENT_REQUIRED_FIELDS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_REQUEST_TYPES,
  RUNTIME_REQUEST_REQUIRED_FIELDS,
  RUNTIME_SCHEMA_VERSION,
  TOOL_STATUS_VALUES,
  type Actor,
  type ErrorCode,
  type ProtocolVersion,
  type RuntimeEventEnvelope,
  type RuntimeRequestEnvelope,
} from './generated.js';

type JsonRecord = Record<string, unknown>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const actorValues = new Set<string>(ACTOR_VALUES);
const approvalValues = new Set<string>(APPROVAL_DECISION_VALUES);
const errorCodeValues = new Set<string>(ERROR_CODE_VALUES);
const eventTypes = new Set<string>(RUNTIME_EVENT_TYPES);
const requestTypes = new Set<string>(RUNTIME_REQUEST_TYPES);
const toolStatusValues = new Set<string>(TOOL_STATUS_VALUES);

export class RuntimeContractViolation extends Error {
  readonly retryable = false;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: JsonRecord,
  ) {
    super(message);
    this.name = 'RuntimeContractViolation';
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENVELOPE', `${label} must be an object`);
  }
  return value as JsonRecord;
}

function requiredId(envelope: JsonRecord, field: string): string {
  const value = envelope[field];
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENVELOPE', `${field} must be a non-empty protocol id`);
  }
  return value;
}

function validateEnvelope(envelope: JsonRecord, kind: 'request' | 'event'): void {
  if (envelope.kind !== kind) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENVELOPE', `kind must be ${kind}`);
  }
  for (const field of ['requestId', 'sessionId', 'turnId', 'stepId', 'traceId', 'eventId']) {
    requiredId(envelope, field);
  }
  if (!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 1) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_SEQUENCE', 'sequence must be a positive safe integer');
  }
  if (typeof envelope.timestamp !== 'string' || !Number.isFinite(Date.parse(envelope.timestamp))) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENVELOPE', 'timestamp must be an ISO-8601 date-time');
  }
  if (typeof envelope.schemaVersion !== 'string') {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENVELOPE', 'schemaVersion must be a semantic version');
  }
  const major = Number(envelope.schemaVersion.split('.')[0]);
  if (major !== RUNTIME_PROTOCOL_VERSION.major) {
    throw new RuntimeContractViolation(
      'RUNTIME_UNSUPPORTED_PROTOCOL_MAJOR',
      `runtime protocol major ${String(major)} is incompatible with ${RUNTIME_PROTOCOL_VERSION.major}`,
    );
  }
  if (envelope.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    throw new RuntimeContractViolation(
      'RUNTIME_INVALID_ENVELOPE',
      `schemaVersion ${envelope.schemaVersion} was not negotiated for this connection`,
    );
  }
  if (typeof envelope.actor !== 'string' || !actorValues.has(envelope.actor)) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENUM', 'actor is not a supported protocol value');
  }
}

function validatePayloadEnums(payload: JsonRecord): void {
  if ((payload.type === 'toolStatus' || payload.type === 'toolResult') && !toolStatusValues.has(String(payload.status))) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENUM', 'tool status is not supported');
  }
  if ((payload.type === 'approval' || payload.type === 'approvalResolved') && !approvalValues.has(String(payload.decision))) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENUM', 'approval decision is not supported');
  }
  if (payload.type === 'error') {
    const error = record(payload.error, 'error');
    if (!errorCodeValues.has(String(error.code))) {
      throw new RuntimeContractViolation('RUNTIME_INVALID_ENUM', 'runtime error code is not stable or supported');
    }
  }
  if (payload.type === 'finished' && !['complete', 'cancelled', 'error'].includes(String(payload.reason))) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENUM', 'finish reason is not supported');
  }
}

function validateRequiredPayloadFields(
  payload: JsonRecord,
  requiredByType: Readonly<Record<string, readonly string[]>>,
): void {
  const type = String(payload.type);
  for (const field of requiredByType[type] ?? []) {
    if (!Object.hasOwn(payload, field) || payload[field] === undefined) {
      throw new RuntimeContractViolation(
        'RUNTIME_INVALID_ENVELOPE',
        `${type}.${field} is required by Runtime Contract v2`,
      );
    }
  }
}

export type DecodedRuntimeEvent =
  | { kind: 'event'; envelope: RuntimeEventEnvelope }
  | { kind: 'ignored'; eventId: string; sequence: number };

export function decodeRuntimeEvent(input: unknown): DecodedRuntimeEvent {
  const envelope = record(input, 'runtime event envelope');
  validateEnvelope(envelope, 'event');
  if (typeof envelope.ignorable !== 'boolean') {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENVELOPE', 'ignorable must be boolean');
  }
  const payload = record(envelope.payload, 'runtime event payload');
  if (typeof payload.type !== 'string' || !eventTypes.has(payload.type)) {
    if (envelope.ignorable === true && typeof payload.type === 'string') {
      return {
        kind: 'ignored',
        eventId: requiredId(envelope, 'eventId'),
        sequence: Number(envelope.sequence),
      };
    }
    throw new RuntimeContractViolation(
      'RUNTIME_UNKNOWN_REQUIRED_EVENT',
      'runtime sent an unknown mandatory event',
      { eventType: typeof payload.type === 'string' ? payload.type : '<missing>' },
    );
  }
  validateRequiredPayloadFields(payload, RUNTIME_EVENT_REQUIRED_FIELDS);
  validatePayloadEnums(payload);
  return { kind: 'event', envelope: input as RuntimeEventEnvelope };
}

export function decodeRuntimeRequest(input: unknown): RuntimeRequestEnvelope {
  const envelope = record(input, 'runtime request envelope');
  validateEnvelope(envelope, 'request');
  const payload = record(envelope.payload, 'runtime request payload');
  if (typeof payload.type !== 'string' || !requestTypes.has(payload.type)) {
    throw new RuntimeContractViolation('RUNTIME_INVALID_ENUM', 'runtime request type is not supported');
  }
  validateRequiredPayloadFields(payload, RUNTIME_REQUEST_REQUIRED_FIELDS);
  validatePayloadEnums(payload);
  return input as RuntimeRequestEnvelope;
}

export type RuntimeSequenceResult = 'accepted' | 'duplicate';

export class RuntimeEventSequence {
  readonly #sessions = new Map<string, { sequence: number; events: Map<string, string> }>();

  accept(envelope: RuntimeEventEnvelope): RuntimeSequenceResult {
    const decoded = decodeRuntimeEvent(envelope);
    if (decoded.kind === 'ignored') return 'accepted';
    const canonical = JSON.stringify(envelope);
    const state = this.#sessions.get(envelope.sessionId) ?? { sequence: 0, events: new Map() };
    const previous = state.events.get(envelope.eventId);
    if (previous !== undefined) {
      if (previous === canonical) return 'duplicate';
      throw new RuntimeContractViolation(
        'RUNTIME_DUPLICATE_EVENT_CONFLICT',
        'eventId was replayed with different content',
      );
    }
    if (envelope.sequence <= state.sequence) {
      throw new RuntimeContractViolation(
        'RUNTIME_INVALID_SEQUENCE',
        `sequence ${envelope.sequence} does not advance session cursor ${state.sequence}`,
      );
    }
    state.sequence = envelope.sequence;
    state.events.set(envelope.eventId, canonical);
    this.#sessions.set(envelope.sessionId, state);
    return 'accepted';
  }
}

export interface RuntimeNegotiationResult {
  protocol: ProtocolVersion;
  capabilities: string[];
}

export function negotiateRuntimeContract(
  remoteVersions: ProtocolVersion[],
  localCapabilities: readonly string[],
  remoteCapabilities: readonly string[],
): RuntimeNegotiationResult {
  const compatible = remoteVersions
    .filter((version) => version.major === RUNTIME_PROTOCOL_VERSION.major)
    .sort((left, right) => right.minor - left.minor || right.patch - left.patch)[0];
  if (!compatible) {
    throw new RuntimeContractViolation(
      'RUNTIME_UNSUPPORTED_PROTOCOL_MAJOR',
      `runtime must support protocol major ${RUNTIME_PROTOCOL_VERSION.major}`,
    );
  }
  const remote = new Set(remoteCapabilities);
  return {
    protocol: compatible,
    capabilities: [...new Set(localCapabilities)].filter((capability) => remote.has(capability)).sort(),
  };
}

export interface V1RuntimeEvent {
  eventId: string;
  sessionId: string;
  sequence: number;
  timestampMs: number;
  turnId?: string;
  stepId?: string;
  actor: Actor;
  traceId?: string;
  payload: JsonRecord;
}

export interface V1AdapterMetric {
  name: 'runtime_contract_v1_adapter_used';
  count: number;
}

/** @deprecated Remove in R11 after the v1 usage counter remains zero for one stable release. */
export class V1RuntimeEventAdapter {
  #uses = 0;

  constructor(private readonly report?: (metric: V1AdapterMetric) => void) {}

  get usageCount(): number {
    return this.#uses;
  }

  adapt(input: V1RuntimeEvent): RuntimeEventEnvelope {
    this.#uses += 1;
    this.report?.({ name: 'runtime_contract_v1_adapter_used', count: this.#uses });
    const type = String(input.payload.type ?? '');
    let payload: JsonRecord;
    if (type === 'userMessage') {
      payload = { type: 'contentDelta', delta: String(input.payload.content ?? '') };
    } else if (type === 'runtimeError') {
      payload = {
        type: 'error',
        error: {
          code: 'RUNTIME_INTERNAL_ERROR',
          message: String(input.payload.message ?? 'Runtime v1 error'),
          retryable: false,
        },
      };
    } else {
      throw new RuntimeContractViolation('RUNTIME_UNKNOWN_REQUIRED_EVENT', `v1 event ${type || '<missing>'} cannot be adapted`);
    }
    const envelope = {
      kind: 'event',
      requestId: `v1:${input.eventId}`,
      sessionId: input.sessionId,
      turnId: input.turnId ?? `v1-turn:${input.eventId}`,
      stepId: input.stepId ?? `v1-step:${input.eventId}`,
      traceId: input.traceId ?? `v1-trace:${input.eventId}`,
      eventId: input.eventId,
      sequence: input.sequence,
      timestamp: new Date(input.timestampMs).toISOString(),
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      actor: input.actor,
      ignorable: false,
      payload,
    } as unknown as RuntimeEventEnvelope;
    const decoded = decodeRuntimeEvent(envelope);
    if (decoded.kind !== 'event') throw new Error('adapted v1 event was unexpectedly ignored');
    return decoded.envelope;
  }
}
