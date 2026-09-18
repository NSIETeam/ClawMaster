/**
 * Feishu API error taxonomy.
 *
 * Document reads must fail distinguishably: a missing OAuth scope must never be mistaken
 * for an empty document, and a throttle must never look like a bug in this plugin.
 */

export interface FeishuErrorOptions {
  readonly code?: number | undefined;
  readonly http?: number | undefined;
  readonly path?: string | undefined;
  readonly cause?: unknown;
}

export class FeishuError extends Error {
  readonly code: number | undefined;
  readonly http: number | undefined;
  readonly path: string | undefined;

  constructor(message: string, options: FeishuErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FeishuError';
    this.code = options.code;
    this.http = options.http;
    this.path = options.path;
  }
}

/** The app authenticated but does not hold the OAuth scope the endpoint requires. */
export class FeishuScopeError extends FeishuError {
  /** Scope names Feishu named in the rejection, when it named any. */
  readonly scopes: readonly string[];

  constructor(message: string, options: FeishuErrorOptions & { scopes?: readonly string[] } = {}) {
    super(message, options);
    this.name = 'FeishuScopeError';
    this.scopes = options.scopes ?? [];
  }
}

/** The tenant token is unusable; the caller must discard it before retrying. */
export class FeishuAuthError extends FeishuError {
  constructor(message: string, options: FeishuErrorOptions = {}) {
    super(message, options);
    this.name = 'FeishuAuthError';
  }
}

/** The deployment is misconfigured. Distinct from every Feishu-side failure. */
export class FeishuConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuConfigError';
  }
}

/** Documented Feishu codes signalling the app has not been granted the scope. */
const SCOPE_CODES = new Set([99991672, 99991663, 99991679, 99991661, 99991668]);
/** Documented Feishu codes for throttling, which are safe to retry. */
const RATE_LIMIT_CODES = new Set([99991400, 99991401]);
/** Documented Feishu codes for an unusable or rejected token. */
const AUTH_CODES = new Set([99991671, 99991664]);

export type FeishuFailureKind = 'ok' | 'scope' | 'rate-limit' | 'auth' | 'api';

export function classifyFeishuCode(code: number | undefined): FeishuFailureKind {
  if (code === 0) return 'ok';
  if (code === undefined) return 'api';
  if (SCOPE_CODES.has(code)) return 'scope';
  if (RATE_LIMIT_CODES.has(code)) return 'rate-limit';
  if (AUTH_CODES.has(code)) return 'auth';
  return 'api';
}

/** Extract the scope names Feishu says are required, so the error is actionable. */
export function requiredScopesFrom(message: unknown): string[] {
  if (typeof message !== 'string') return [];
  const match = /\[([^\]]+)\]/.exec(message);
  if (match === null) return [];
  return (match[1] ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '');
}
