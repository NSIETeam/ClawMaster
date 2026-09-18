import {
  FeishuAuthError,
  FeishuError,
  FeishuScopeError,
  classifyFeishuCode,
  requiredScopesFrom,
} from './errors.ts';

const ORIGINS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
} as const;

export type FeishuDomain = keyof typeof ORIGINS;

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
/** Refresh slightly before expiry so an in-flight call cannot use a dead token. */
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

/** Result of verifying the app's own identity; never carries a secret or a token. */
export interface FeishuIdentity {
  readonly appId: string;
  readonly name: string | null;
  readonly openId: string | null;
  readonly activated: number | null;
}

export interface FeishuClientOptions {
  readonly appId: string;
  /**
   * Resolve the app secret on demand.
   *
   * Deliberately a function rather than a value: the client stores only the short-lived
   * tenant token it derives, so the long-lived secret never becomes instance state and
   * a rotated secret is picked up at the next token refresh.
   */
  readonly resolveSecret: () => Promise<string>;
  readonly domain?: FeishuDomain;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export interface FeishuRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly authenticate?: boolean;
  readonly signal?: AbortSignal;
}

interface FeishuEnvelope {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: Record<string, unknown>;
  readonly [member: string]: unknown;
}

function backoffMs(attempt: number, base = 300): number {
  return Math.min(base * 2 ** (attempt - 1), 5_000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Minimal Feishu Open API client.
 *
 * Exchanges a credential-seam reference for a cached tenant access token and never
 * exposes the token or the secret to a caller, a log line, or a serialised result.
 */
export class FeishuClient {
  readonly #appId: string;
  readonly #resolveSecret: () => Promise<string>;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  #token: string | null = null;
  #tokenExpiresAt = 0;
  #tokenPromise: Promise<string> | null = null;

  constructor(options: FeishuClientOptions) {
    if (typeof options.appId !== 'string' || options.appId === '') throw new TypeError('FeishuClient requires appId');
    if (typeof options.resolveSecret !== 'function') throw new TypeError('FeishuClient requires resolveSecret');
    const domain = options.domain ?? 'feishu';
    const origin = ORIGINS[domain];
    if (origin === undefined) throw new TypeError(`Unsupported Feishu domain: ${String(domain)}`);
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }
    this.#appId = options.appId;
    this.#resolveSecret = options.resolveSecret;
    this.#origin = origin;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Exchange the app secret for a tenant token, with caching and single-flight. */
  async #tenantToken(): Promise<string> {
    if (this.#token !== null && this.#now() < this.#tokenExpiresAt) return this.#token;
    if (this.#tokenPromise !== null) return this.#tokenPromise;

    this.#tokenPromise = (async () => {
      const secret = await this.#resolveSecret();
      if (typeof secret !== 'string' || secret === '') {
        throw new FeishuAuthError('The configured Feishu app secret reference resolved to an empty value');
      }
      const payload = await this.#send(TOKEN_PATH, {
        method: 'POST',
        body: { app_id: this.#appId, app_secret: secret },
        authenticate: false,
      });
      const token = payload.tenant_access_token;
      if (typeof token !== 'string' || token === '') {
        throw new FeishuAuthError('Feishu authentication returned no tenant access token', { path: TOKEN_PATH });
      }
      const expireSeconds = Number(payload.expire);
      const ttlMs = Number.isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds * 1000 : 7_200_000;
      this.#token = token;
      this.#tokenExpiresAt = this.#now() + ttlMs - TOKEN_REFRESH_SKEW_MS;
      return token;
    })().finally(() => {
      this.#tokenPromise = null;
    });

    return this.#tokenPromise;
  }

  #signalFor(external: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    return external === undefined ? timeout : AbortSignal.any([external, timeout]);
  }

  /** Low-level call. Resolves the raw Feishu envelope; rejects on any non-zero code. */
  async #send(path: string, options: FeishuRequestOptions = {}): Promise<FeishuEnvelope> {
    const method = options.method ?? 'GET';
    const url = new URL(path, this.#origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (options.authenticate !== false) headers.authorization = `Bearer ${await this.#tenantToken()}`;

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        const init: RequestInit = { method, headers, signal: this.#signalFor(options.signal) };
        // Omit `body` entirely for a bodyless call: the repo compiles with
        // exactOptionalPropertyTypes, where `body: undefined` is not a RequestInit.
        if (options.body !== undefined) init.body = JSON.stringify(options.body);
        response = await this.#fetch(url, init);
      } catch (error) {
        if (attempt < this.#maxRetries) {
          attempt += 1;
          await this.#sleep(backoffMs(attempt));
          continue;
        }
        throw new FeishuError(`Feishu request failed: ${method} ${path}`, { path, cause: error });
      }

      let payload: FeishuEnvelope;
      try {
        payload = await response.json() as FeishuEnvelope;
      } catch (error) {
        throw new FeishuError(`Feishu returned a non-JSON response: ${method} ${path}`, {
          http: response.status,
          path,
          cause: error,
        });
      }

      const code = payload.code;
      const kind = classifyFeishuCode(code);
      if (kind === 'ok') return payload;

      if (kind === 'rate-limit' && attempt < this.#maxRetries) {
        attempt += 1;
        await this.#sleep(backoffMs(attempt));
        continue;
      }

      const detail = `${method} ${path} failed: code ${String(code)}${typeof payload.msg === 'string' && payload.msg !== '' ? ` ${payload.msg}` : ''}`;
      const meta = { code, http: response.status, path };

      if (kind === 'scope') {
        const scopes = requiredScopesFrom(payload.msg);
        throw new FeishuScopeError(
          scopes.length > 0 ? `${detail} — required scopes: ${scopes.join(', ')}` : detail,
          { ...meta, scopes },
        );
      }
      if (kind === 'auth') throw new FeishuAuthError(detail, meta);
      throw new FeishuError(detail, meta);
    }
  }

  /** Public call returning `data` from the Feishu envelope. */
  async request(path: string, options: FeishuRequestOptions = {}): Promise<Record<string, unknown>> {
    const payload = await this.#send(path, options);
    return asRecord(payload.data);
  }

  /**
   * Verify credentials and read the bot identity. Never returns the token.
   *
   * `/bot/v3/info` returns `bot` at the TOP level of the envelope (verified against the
   * live API on 2026-09-14), unlike the list endpoints that nest their payload under
   * `data`. Both shapes are accepted so an API move cannot silently null this out.
   */
  async whoami(): Promise<FeishuIdentity> {
    const payload = await this.#send('/open-apis/bot/v3/info/');
    const bot = asRecord(payload.bot ?? asRecord(payload.data).bot);
    const name = bot.app_name ?? bot.bot_name;
    const openId = bot.open_id;
    const activated = bot.activate_status;
    return Object.freeze({
      appId: this.#appId,
      name: typeof name === 'string' ? name : null,
      openId: typeof openId === 'string' ? openId : null,
      activated: typeof activated === 'number' ? activated : null,
    });
  }

  /**
   * Follow `page_token` until exhausted.
   *
   * Feishu reports `has_more` even when it also returns an empty page, so this stops on
   * either signal and additionally guards against a server that echoes one token forever.
   */
  async getAll<T>(
    path: string,
    options: {
      readonly query?: Readonly<Record<string, string | number | undefined>>;
      readonly pageSize?: number;
      readonly pick?: (data: Record<string, unknown>) => readonly T[];
    } = {},
  ): Promise<T[]> {
    const pick = options.pick ?? (data => (Array.isArray(data.items) ? data.items as T[] : []));
    const collected: T[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const data = await this.request(path, {
        query: { ...options.query, page_size: options.pageSize ?? 500, page_token: pageToken },
      });
      collected.push(...pick(data));
      if (data.has_more !== true) break;
      const next = data.page_token;
      if (typeof next !== 'string' || next === '' || seen.has(next)) break;
      seen.add(next);
      pageToken = next;
    }
    return collected;
  }
}
