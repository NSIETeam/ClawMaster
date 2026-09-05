import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeRuntimeEvent,
  decodeRuntimeRequest,
  negotiateRuntimeContract,
  RuntimeContractViolation,
  RuntimeEventSequence,
  V1RuntimeEventAdapter,
  type RuntimeEventEnvelope,
} from './index.js';

const goldenEvent = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/content-delta.v2.json', import.meta.url)), 'utf8'),
) as RuntimeEventEnvelope;
const goldenRequest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/prompt.v2.json', import.meta.url)), 'utf8'),
);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error('expected RuntimeContractViolation');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeContractViolation);
    expect((error as RuntimeContractViolation).code).toBe(code);
  }
}

describe('Runtime Contract v2 TypeScript boundary', () => {
  it('round-trips the shared event and request golden frames semantically', () => {
    const event = decodeRuntimeEvent(clone(goldenEvent));
    expect(event.kind).toBe('event');
    if (event.kind === 'event') expect(JSON.parse(JSON.stringify(event.envelope))).toEqual(goldenEvent);
    expect(JSON.parse(JSON.stringify(decodeRuntimeRequest(clone(goldenRequest))))).toEqual(goldenRequest);
  });

  it('rejects missing ids, illegal sequence, enum, and protocol major', () => {
    const missingId = clone(goldenEvent) as unknown as Record<string, unknown>;
    delete missingId.turnId;
    expectCode(() => decodeRuntimeEvent(missingId), 'RUNTIME_INVALID_ENVELOPE');
    expectCode(() => decodeRuntimeEvent({ ...goldenEvent, sequence: 0 }), 'RUNTIME_INVALID_SEQUENCE');
    expectCode(() => decodeRuntimeEvent({ ...goldenEvent, actor: 'operator' }), 'RUNTIME_INVALID_ENUM');
    expectCode(
      () => decodeRuntimeEvent({ ...goldenEvent, schemaVersion: '3.0.0' }),
      'RUNTIME_UNSUPPORTED_PROTOCOL_MAJOR',
    );
  });

  it('rejects a known payload when a schema-required field is absent', () => {
    expectCode(
      () => decodeRuntimeEvent({ ...goldenEvent, payload: { type: 'contentDelta' } }),
      'RUNTIME_INVALID_ENVELOPE',
    );
    expectCode(
      () => decodeRuntimeRequest({ ...goldenRequest, payload: { type: 'prompt', stream: true } }),
      'RUNTIME_INVALID_ENVELOPE',
    );
  });

  it('skips unknown ignorable events and rejects unknown mandatory events', () => {
    const unknown = { ...goldenEvent, payload: { type: 'futureTelemetry', sample: 1 } };
    expect(decodeRuntimeEvent({ ...unknown, ignorable: true })).toEqual({
      kind: 'ignored',
      eventId: 'event-1',
      sequence: 1,
    });
    expectCode(
      () => decodeRuntimeEvent({ ...unknown, ignorable: false }),
      'RUNTIME_UNKNOWN_REQUIRED_EVENT',
    );
  });

  it('enforces monotonic sequence and idempotent event replay', () => {
    const sequence = new RuntimeEventSequence();
    expect(sequence.accept(goldenEvent)).toBe('accepted');
    expect(sequence.accept(clone(goldenEvent))).toBe('duplicate');
    expectCode(
      () => sequence.accept({ ...goldenEvent, eventId: 'event-2', sequence: 1 }),
      'RUNTIME_INVALID_SEQUENCE',
    );
    expectCode(
      () => sequence.accept({ ...goldenEvent, payload: { type: 'contentDelta', delta: 'changed' } }),
      'RUNTIME_DUPLICATE_EVENT_CONFLICT',
    );
  });

  it('negotiates minor versions through shared capabilities and rejects another major', () => {
    expect(
      negotiateRuntimeContract(
        [{ major: 2, minor: 3, patch: 1 }, { major: 1, minor: 9, patch: 0 }],
        ['stream', 'checkpoint', 'stream'],
        ['stream', 'usage'],
      ),
    ).toEqual({ protocol: { major: 2, minor: 3, patch: 1 }, capabilities: ['stream'] });
    expectCode(
      () => negotiateRuntimeContract([{ major: 1, minor: 0, patch: 0 }], [], []),
      'RUNTIME_UNSUPPORTED_PROTOCOL_MAJOR',
    );
  });

  it('adapts the supported v1 event with an observable usage counter', () => {
    const report = vi.fn();
    const adapter = new V1RuntimeEventAdapter(report);
    const adapted = adapter.adapt({
      eventId: 'legacy-1',
      sessionId: 'session-1',
      sequence: 1,
      timestampMs: Date.parse('2026-09-06T00:00:00.000Z'),
      actor: 'assistant',
      payload: { type: 'userMessage', content: 'legacy content' },
    });
    expect(adapted.payload).toEqual({ type: 'contentDelta', delta: 'legacy content' });
    expect(adapter.usageCount).toBe(1);
    expect(report).toHaveBeenCalledWith({ name: 'runtime_contract_v1_adapter_used', count: 1 });
  });
});
