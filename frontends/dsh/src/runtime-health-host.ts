/** Component health for the operator's own desktop, refused wherever the Host is a shared deployment. */
import type { GovernanceAccess } from './governance-access.ts';
import type { RuntimeObservation } from './runtime-governance.ts';

const path = '/api/clawmaster/runtime';

/** The single route registration this consumer needs. */
export interface RuntimeHealthContext {
  connection: { fetch: { register(route: {
    path: string; methods: readonly ('GET' | 'POST')[]; requestBody: 'buffered' | 'streaming';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void> } };
}

/** What the home's component layer reads, with no filesystem path, digest or credential in it.
 * @param observedAt - When the Host last read its own runtime record.
 * @param available - Whether a current record described this Host process.
 * @param reason - Why no record was used, or null when one was.
 * @param mode - `release` or `development`, or null when unobserved.
 * @param components - Loaded component count, or null when unobserved.
 * @param disabledPlugins - Plugins this Host disabled, named because silence would hide them.
 */
export interface RuntimeHealthView {
  observedAt: string;
  available: boolean;
  reason: string | null;
  mode: string | null;
  components: number | null;
  disabledPlugins: string[];
}

/** Project one Host runtime observation into component health, without disclosing the inventory it holds. */
export function runtimeHealthView(observed: RuntimeObservation): RuntimeHealthView {
  const identity = observed.identity;
  return {
    observedAt: observed.observedAt, available: observed.available, reason: observed.reason,
    mode: identity?.source?.mode ?? null,
    components: identity?.inventory == null ? null : identity.inventory.components.length,
    disabledPlugins: identity?.disabledPlugins ?? [],
  };
}

/**
 * Serve component health to the local operator and refuse it to every other caller.
 * @param ctx - Host Fetch registration.
 * @param access - Current governance mode; a shared deployment never receives Host facts.
 * @param observe - Reads the Host's current runtime record; injected so this route reads no file itself.
 * @returns The route's disposer.
 */
export function mountRuntimeHealth(ctx: RuntimeHealthContext, access: GovernanceAccess,
  observe: () => RuntimeObservation): () => Promise<void> {
  const denied = access.mode !== 'local';
  return ctx.connection.fetch.register({
    path, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      if (new URL(request.url).search !== '') {
        return Response.json({ error: { code: 'invalid_request', message: 'The runtime health path takes no query.' } },
          { status: 400, headers: { 'cache-control': 'no-store' } });
      }
      // A shared Host serves identities that are not the operator of this machine, so its component
      // inventory stays out of the browser even though the mode that would read it is still local.
      if (denied) {
        return Response.json({ error: { code: 'permission_denied', message: 'Component health is served only where the Host runs the operator\'s own desktop.' } },
          { status: 403, headers: { 'cache-control': 'no-store' } });
      }
      return Response.json(runtimeHealthView(observe()), { headers: { 'cache-control': 'no-store' } });
    },
  });
}
