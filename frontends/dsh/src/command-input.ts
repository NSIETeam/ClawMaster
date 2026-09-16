/** Shared admission and bounded JSON reads for business commands, including slow HTTP senders. */
import { z } from 'zod';
import { EnterpriseError } from './enterprise-types.ts';

const configSchema = z.object({
  maxRequestBytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER).default(1048576),
  maxConcurrentCommands: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  readTimeoutMs: z.number().int().min(1).max(2147483647).default(30000),
}).strict();

/** Deployment limits shared by record, task and schedule command consumers. */
export type GovernanceCommandConfig = z.input<typeof configSchema>;

/** Capacity errors are definite refusals before a command can write or request approval. */
export class CommandInputError extends EnterpriseError {
  readonly status: number;
  constructor(code: 'invalid_request' | 'result_too_large' | 'storage_unavailable', message: string, status: number) {
    super(code, message);
    this.status = status;
  }

  /**
   * Serialize a small refusal that existing clients can distinguish from a lost response.
   * @returns A non-cacheable HTTP error response.
   */
  response(): Response {
    return Response.json({ error: { code: this.code, message: this.message } }, {
      status: this.status, headers: { 'cache-control': 'no-store' },
    });
  }
}

/** One Host shares this owner across all command routes and tools; reads stay available at capacity. */
export class GovernanceCommandInput {
  readonly limits: Readonly<z.output<typeof configSchema>>;
  private active = 0;

  constructor(config: GovernanceCommandConfig = {}) {
    this.limits = Object.freeze(configSchema.parse(config));
  }

  /**
   * Hold one command slot from authentication through approval and commit.
   * @param signal Request or consumer cancellation.
   * @param action Command work; the caller owns authorization and durable writes.
   * @returns The command result, releasing capacity after success or failure.
   */
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.limits.maxConcurrentCommands) {
      throw new CommandInputError('storage_unavailable', 'Business command capacity is full. Finish or cancel an active command and retry.', 503);
    }
    this.active++;
    try { return await action(); }
    finally { this.active--; }
  }

  /**
   * Resolve the trusted caller before reading JSON under a deadline and UTF-8 byte budget.
   * @param request Original streaming carrier request; identity providers may bind to this object.
   * @param signal Request and consumer lifetime cancellation.
   * @param authenticate Trusted identity resolver, called before body access.
   * @returns Authenticated caller and unvalidated command JSON; semantic checks remain consumer-owned.
   */
  async receive<T>(request: Request, signal: AbortSignal, authenticate: (signal: AbortSignal) => Promise<T>): Promise<{ caller: T; value: unknown }> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new CommandInputError('storage_unavailable', 'Business command upload timed out. Retry the complete command.', 408)), this.limits.readTimeoutMs);
    const readSignal = AbortSignal.any([signal, timeout.signal]);
    try {
      const caller = await authenticate(readSignal);
      readSignal.throwIfAborted();
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        throw new CommandInputError('invalid_request', 'Business commands require application/json.', 400);
      }
      const length = request.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
        throw new CommandInputError('invalid_request', 'Command content length is invalid.', 400);
      }
      if (length !== null && Number(length) > this.limits.maxRequestBytes) throw this.tooLarge();
      if (!request.body) throw new CommandInputError('invalid_request', 'Command JSON is missing.', 400);
      const reader = request.body.getReader();
      // The Node HTTP carrier closes unread requests after writing the response; cancelling here would destroy its socket first.
      const stopRead = () => reader.releaseLock();
      readSignal.addEventListener('abort', stopRead, { once: true });
      try {
        let body = Buffer.alloc(0);
        let bytes = 0;
        for (;;) {
          readSignal.throwIfAborted();
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); }
          catch (error) { readSignal.throwIfAborted(); throw error; }
          const { value, done } = chunk;
          readSignal.throwIfAborted();
          if (done) break;
          const end = bytes + value.byteLength;
          if (end > this.limits.maxRequestBytes) throw this.tooLarge();
          if (end > body.length) {
            const expanded = Buffer.allocUnsafe(Math.min(this.limits.maxRequestBytes, Math.max(end, body.length * 2)));
            body.copy(expanded, 0, 0, bytes);
            body = expanded;
          }
          body.set(value, bytes);
          bytes = end;
        }
        if (length !== null && bytes !== Number(length)) throw new CommandInputError('invalid_request', 'Command body length differs from its header.', 400);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes))); }
        catch { throw new CommandInputError('invalid_request', 'Command JSON is malformed or is not UTF-8.', 400); }
        return { caller, value };
      } finally {
        readSignal.removeEventListener('abort', stopRead);
        reader.releaseLock();
      }
    } finally { clearTimeout(timer); }
  }

  /**
   * Check the complete parsed tool arguments before semantic parsing or approval.
   * @param value Decoded tool arguments supplied by the tool runtime.
   */
  checkArguments(value: unknown): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new CommandInputError('invalid_request', 'Command arguments must be JSON.', 400);
    if (Buffer.byteLength(encoded, 'utf8') > this.limits.maxRequestBytes) throw this.tooLarge();
  }

  private tooLarge(): CommandInputError {
    return new CommandInputError('result_too_large', `Business command exceeds the configured ${this.limits.maxRequestBytes}-byte input budget.`, 413);
  }
}
