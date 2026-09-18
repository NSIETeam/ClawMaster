/**
 * Built-in ClawMaster Feishu reads: read-only Docx/Wiki/Drive tools plus two diagnostic
 * Fetch routes.
 *
 * Every tool here is L0 observe — none requests approval, and this package registers no
 * write tool at all. The app secret is resolved per token acquisition from the DSH
 * credential provider, never held on the client and never returned to a caller.
 */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type CredentialProvider from '@deepseek-ai/dsh-credentials';
import { FeishuClient } from './client.ts';
import { FeishuAuthError, FeishuConfigError, FeishuError, FeishuScopeError } from './errors.ts';
import {
  FEISHU_CAPABILITIES_PATH,
  FEISHU_WHOAMI_PATH,
  capabilitiesSchema,
  docReadSchema,
  documentTokenFrom,
  driveListSchema,
  wikiNodesSchema,
  wikiReadSchema,
  wikiSpacesSchema,
  whoamiSchema,
} from './protocol.ts';
import {
  listDriveFiles,
  listWikiNodes,
  listWikiSpaces,
  probeCapabilities,
  readDocument,
  readWikiDocument,
} from './resources.ts';

export const name = 'clawmaster-feishu-docs';
export const inject = ['connection', 'tools', 'credentials'];

/** One route on DSH's authenticated Fetch carrier, which owns authentication and origin checks. */
export interface FeishuFetchRegistry {
  register(route: {
    path: string;
    methods: readonly ('GET' | 'POST')[];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void>;
}

/** A credential reference is a POSIX-style environment-variable name. */
type CredentialRef = Parameters<CredentialProvider['resolve']>[0];

/** The public DSH services this plugin consumes. */
export interface FeishuHostContext {
  connection: { fetch: FeishuFetchRegistry };
  tools: Pick<ToolRuntime, 'register'>;
  credentials: Pick<CredentialProvider, 'resolve'>;
  effect: Context['effect'];
}

/**
 * The Feishu app is owned by the deployment's tenant, so its id and secret reference are
 * configuration and never constants. No default app is assumed.
 */
const configSchema = z.object({
  appId: z.string().min(1),
  appSecretRef: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A credential reference is a POSIX environment-variable name.'),
  domain: z.enum(['feishu', 'lark']).default('feishu'),
  timeoutMs: z.number().int().min(1000).max(120000).default(20_000),
  maxRetries: z.number().int().min(0).max(5).default(3),
}).strict();

export type FeishuHostConfig = z.input<typeof configSchema>;

const output: Record<string, unknown> = { type: 'object', additionalProperties: true };
const readText = (description: string): Record<string, unknown> => ({ type: 'string', description });

function errorResponse(error: unknown): Response {
  const status = error instanceof FeishuConfigError ? 500
    : error instanceof FeishuScopeError ? 403
      : error instanceof FeishuAuthError ? 502
        : error instanceof FeishuError ? 502
          : error instanceof z.ZodError ? 400
            : 500;
  const code = error instanceof FeishuConfigError ? 'not_configured'
    : error instanceof FeishuScopeError ? 'missing_scope'
      : error instanceof FeishuAuthError ? 'feishu_auth'
        : error instanceof FeishuError ? 'feishu_error'
          : error instanceof z.ZodError ? 'invalid_request'
            : 'internal';
  const message = error instanceof Error ? error.message : 'Feishu document access failed.';
  const requiredScopes = error instanceof FeishuScopeError && error.scopes.length > 0
    ? { requiredScopes: [...error.scopes] }
    : {};
  return Response.json(
    { error: { code, message, ...requiredScopes } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Register the Feishu read surface for the plugin lifetime.
 * @param ctx - DSH Fetch, tool and credential services.
 * @param config - The deployment's Feishu app id and credential reference.
 */
export async function apply(ctx: FeishuHostContext, config: FeishuHostConfig): Promise<void> {
  const options = configSchema.parse(config);

  await ctx.effect(async () => {
    const client = new FeishuClient({
      appId: options.appId,
      domain: options.domain,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      resolveSecret: async () => {
        const resolved = await ctx.credentials.resolve(options.appSecretRef as CredentialRef);
        const value = resolved?.value;
        if (typeof value !== 'string' || value === '') {
          throw new FeishuConfigError(
            `Credential reference ${options.appSecretRef} is not configured; set it before reading Feishu.`,
          );
        }
        return value;
      },
    });

    const disposers: Array<() => Promise<void>> = [];
    const removals: Array<() => void> = [];
    const lifetime = new AbortController();
    let closing = false;

    const runTool = (exec: ToolRunContext, action: () => Promise<unknown>): Promise<unknown> => {
      const signal = AbortSignal.any([lifetime.signal, exec.signal]);
      return Promise.resolve().then(() => {
        signal.throwIfAborted();
        return action();
      });
    };

    const handle = (operation: () => Promise<unknown>) => async (): Promise<Response> => {
      if (closing) return errorResponse(new FeishuConfigError('Feishu routes are closed.'));
      try {
        return Response.json(await operation(), { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return errorResponse(error);
      }
    };

    const register = (definition: ToolDefinition): void => {
      removals.push(ctx.tools.register(definition));
    };

    /**
     * Identify the app and probe its scopes.
     *
     * An identity failure is reported rather than thrown: this report exists to diagnose
     * a broken Feishu setup, so losing the probe results because the identity call itself
     * failed would defeat its purpose.
     */
    const capabilityReport = async (): Promise<Record<string, unknown>> => {
      let identity: unknown = null;
      let identityError: string | null = null;
      try {
        identity = await client.whoami();
      } catch (error) {
        identityError = error instanceof Error ? error.message : String(error);
      }
      return { identity, identityError, probes: await probeCapabilities(client) };
    };

    const render = (_args: unknown, value: unknown): { type: 'text'; text: string }[] =>
      [{ type: 'text', text: JSON.stringify(value) }];

    try {
      disposers.push(ctx.connection.fetch.register({
        path: FEISHU_WHOAMI_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async () => client.whoami()),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: FEISHU_CAPABILITIES_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(capabilityReport),
      }));

      register({
        name: 'feishu_whoami',
        description: 'Report the configured Feishu app identity (bot name, open id, activation state). Read-only and never needs approval. Use it to confirm the credential reference resolves and the app authenticates before any document read.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          whoamiSchema.parse(args);
          return client.whoami();
        }),
      });

      register({
        name: 'feishu_capabilities',
        description: 'Probe which Feishu read capabilities this app currently holds. Read-only and never needs approval. Each entry is a real call classified as granted, missing-scope (with the exact scopes Feishu says are required) or error, so a deployment can tell "no documents" apart from "no permission". An identity-lookup failure is reported in identityError while the probes still run. Run this first when a Feishu read fails.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          capabilitiesSchema.parse(args);
          return capabilityReport();
        }),
      });

      register({
        name: 'feishu_doc_read',
        description: 'Read one Feishu docx document and render it as Markdown. Read-only and never needs approval. Accepts a document token or a full Feishu document URL. Requires the docx read scope on the app; when it is missing the error names the scopes Feishu requires.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['document'],
          properties: {
            document: readText('A docx document token, or a full Feishu document URL to extract one from.'),
          },
        },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          const { document } = docReadSchema.parse(args);
          return readDocument(client, documentTokenFrom(document));
        }),
      });

      register({
        name: 'feishu_wiki_spaces',
        description: 'List the Feishu wiki spaces this app can see. Read-only and never needs approval. Requires the wiki read scope.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          wikiSpacesSchema.parse(args);
          return { spaces: await listWikiSpaces(client) };
        }),
      });

      register({
        name: 'feishu_wiki_nodes',
        description: 'List the nodes of one Feishu wiki space, optionally under a parent node. Read-only and never needs approval. Requires the wiki read scope.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['spaceId'],
          properties: {
            spaceId: readText('The wiki space id returned by feishu_wiki_spaces.'),
            parentNodeToken: readText('Optional parent node token; omit for the space root.'),
          },
        },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          const parsed = wikiNodesSchema.parse(args);
          return { nodes: await listWikiNodes(client, parsed.spaceId, parsed.parentNodeToken) };
        }),
      });

      register({
        name: 'feishu_wiki_read',
        description: 'Read one Feishu wiki node as Markdown by resolving its wrapper to the underlying document. Read-only and never needs approval. A node wrapping a sheet, bitable or other non-document type is reported instead of being rendered as empty text.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['token'],
          properties: { token: readText('The wiki node token.') },
        },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          const { token } = wikiReadSchema.parse(args);
          return readWikiDocument(client, token);
        }),
      });

      register({
        name: 'feishu_drive_list',
        description: 'List files and folders in a Feishu cloud-drive folder. Read-only and never needs approval. Omit folderToken to list the root the app can see. Requires the drive read scope.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { folderToken: readText('Optional folder token; omit for the drive root.') },
        },
        output: { schema: output, render },
        execute: (args, exec) => runTool(exec, async () => {
          const parsed = driveListSchema.parse(args);
          return { files: await listDriveFiles(client, parsed.folderToken) };
        }),
      });

      return async () => {
        closing = true;
        lifetime.abort(new Error('Feishu docs plugin was unloaded.'));
        const removed = await Promise.allSettled([...disposers, ...removals].map(async remove => remove()));
        const failed = removed.filter(result => result.status === 'rejected');
        if (failed.length > 0) {
          throw new AggregateError(
            failed.map(result => (result as PromiseRejectedResult).reason),
            'Feishu routes and tools could not be removed.',
          );
        }
      };
    } catch (error) {
      await Promise.allSettled([...disposers, ...removals].map(async remove => remove()));
      throw error;
    }
  }, 'clawmaster: feishu document reads');
}
