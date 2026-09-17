/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

const PREFIX = '\u001eCLAWMASTER_RPA_V1:';
const MAX_FRAME_BYTES = 1024 * 1024;

/** Exact write request sent from the DSH Host to its spawning desktop process. */
export interface NativeBrokerRequest {
  callId: string;
  tool: string;
  root: string;
  arguments: Record<string, unknown>;
  summary: string;
  argumentsSha256: string;
}

/** Exact read-only request sent from the DSH Host to its spawning desktop process. */
export type NativeBrokerReadRequest = Pick<NativeBrokerRequest, 'callId' | 'tool' | 'root' | 'arguments'>

/** One request/reply operation on the inherited Host stdio channel. */
export interface NativeApprovalBroker {
  /** @param request The DSH-approved write to confirm and execute. */
  execute(request: Omit<NativeBrokerRequest, 'argumentsSha256'>, signal?: AbortSignal): Promise<unknown>;
  /** @param request The read-only action to execute through the Host-owned controller. */
  read(request: NativeBrokerReadRequest, signal?: AbortSignal): Promise<unknown>;
}

let sharedBroker: NativeApprovalBroker | undefined;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right)).map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Create a fail-closed broker over the child process's inherited stdin/stdout. */
export function createNativeApprovalBroker(): NativeApprovalBroker {
  if (sharedBroker) return sharedBroker;
  sharedBroker = createApprovalBroker({ stdin: process.stdin, stdout: process.stdout });
  return sharedBroker;
}

/** Create an approval broker over the desktop process pipes. */
export function createApprovalBroker(inputStreams: { stdin: Readable; stdout: Writable; readyTimeoutMs?: number; requestTimeoutMs?: number }): NativeApprovalBroker {
  const readyTimeoutMs = inputStreams.readyTimeoutMs ?? 2_000;
  const requestTimeoutMs = inputStreams.requestTimeoutMs ?? 30_000;
  const pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    signal?: AbortSignal;
    onAbort?: () => void;
    timer: NodeJS.Timeout;
  }>();
  let input = '';
  let readyResolver: ((value: boolean) => void) | undefined;
  const ready = new Promise<boolean>((resolve) => { readyResolver = resolve; });
  let onData: ((chunk: string) => void) | undefined;
  const readyTimer = setTimeout(() => {
    readyResolver?.(false);
    if (onData) {
      inputStreams.stdin.removeListener('data', onData);
      if (inputStreams.stdin.listenerCount('data') === 0) inputStreams.stdin.pause();
    }
  }, readyTimeoutMs);
  readyTimer.unref();
  if ('setEncoding' in inputStreams.stdin && typeof inputStreams.stdin.setEncoding === 'function') inputStreams.stdin.setEncoding('utf8');
  onData = (chunk: string): void => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_FRAME_BYTES) {
      for (const item of pending.values()) item.reject(new Error('Native RPA approval channel exceeded its frame limit.'));
      pending.clear();
      return;
    }
    for (;;) {
      const end = input.indexOf('\n');
      if (end < 0) break;
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      let frame: { protocol?: string; type?: string; callId?: string; result?: unknown; error?: string; supported?: boolean };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue;
      }
      if (frame.protocol !== 'clawmaster-rpa/1') continue;
      if (frame.type === 'ready') {
        clearTimeout(readyTimer);
        readyResolver?.(frame.supported === true);
        continue;
      }
      if (frame.type === 'hello') {
        inputStreams.stdout.write(`${PREFIX}${JSON.stringify({ protocol: 'clawmaster-rpa/1', type: 'hello' })}\n`);
        continue;
      }
      if (frame.type !== 'result' || !frame.callId) continue;
      const item = pending.get(frame.callId);
      if (!item) continue;
      pending.delete(frame.callId);
      clearTimeout(item.timer);
      if (item.onAbort) item.signal?.removeEventListener('abort', item.onAbort);
      if (frame.error) item.reject(new Error(frame.error));
      else item.resolve(frame.result);
    }
  };
  inputStreams.stdin.on('data', onData);
  inputStreams.stdout.write(`${PREFIX}${JSON.stringify({ protocol: 'clawmaster-rpa/1', type: 'hello' })}\n`);

  const send = (kind: 'request' | 'read', request: NativeBrokerReadRequest & Partial<Pick<NativeBrokerRequest, 'summary'>>, signal?: AbortSignal): Promise<unknown> => {
      if (signal?.aborted) return Promise.reject(new Error('Native RPA approval was cancelled before dispatch.'));
      if (pending.has(request.callId)) return Promise.reject(new Error('Native RPA callId is already in flight.'));
      readyTimer.ref();
      const argsJson = JSON.stringify(canonical(request.arguments));
      const complete: NativeBrokerRequest = {
        ...request,
        summary: request.summary ?? '',
        argumentsSha256: createHash('sha256').update(argsJson).digest('hex'),
      };
      return ready.then((supported) => {
        if (!supported) throw new Error('Native RPA confirmation broker is unavailable in this runtime; the action was not dispatched.');
        if (signal?.aborted) throw new Error('Native RPA approval was cancelled before dispatch.');
        return new Promise((resolve, reject) => {
          const onAbort = (): void => {
            inputStreams.stdout.write(`${PREFIX}${JSON.stringify({ protocol: 'clawmaster-rpa/1', type: 'cancel', callId: request.callId })}\n`);
            pending.delete(request.callId);
            clearTimeout(timer);
            reject(new Error('Native RPA approval was cancelled.'));
          };
          const timer = setTimeout(() => {
            pending.delete(request.callId);
            signal?.removeEventListener('abort', onAbort);
            inputStreams.stdout.write(`${PREFIX}${JSON.stringify({ protocol: 'clawmaster-rpa/1', type: 'cancel', callId: request.callId })}\n`);
            reject(new Error('Native RPA approval channel timed out; the action outcome is unknown.'));
          }, requestTimeoutMs);
          signal?.addEventListener('abort', onAbort, { once: true });
          pending.set(request.callId, { resolve, reject, ...(signal ? { signal } : {}), onAbort, timer });
          inputStreams.stdout.write(`${PREFIX}${JSON.stringify({ protocol: 'clawmaster-rpa/1', type: kind, request: complete })}\n`, (error) => {
            if (!error) return;
            pending.delete(request.callId);
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          });
        });
      });
  };

  return {
    execute(request, signal) { return send('request', request, signal); },
    read(request, signal) { return send('read', request, signal); },
  };
}
