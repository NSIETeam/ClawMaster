/** Browser-only component health read; a refused or absent route stays unobserved rather than guessed. */
import { z } from 'zod';

const view = z.object({
  observedAt: z.string(), available: z.boolean(), reason: z.string().nullable(), mode: z.string().nullable(),
  components: z.number().int().nonnegative().nullable(), disabledPlugins: z.array(z.string()),
});

/** What the home's component layer knows, including that it knows nothing. */
export interface RuntimeHealthState {
  /** A view was read from the Host; false covers every failure, including a refusal. */
  observed: boolean;
  /** The Host held a current record of its own process. */
  available: boolean;
  components: number | null;
  /** Plugins this Host disabled, named because silence would hide them. */
  disabled: string[];
  /** The Host refused this caller, which is what a shared deployment does. */
  refused: boolean;
  observedAt: string | null;
  loading: boolean;
}

/** Read the Host's component health once per refresh; a second call while one is in flight is ignored. */
export class RuntimeHealthClient {
  private state: RuntimeHealthState = { observed: false, available: false, components: null, disabled: [], refused: false, observedAt: null, loading: false };
  private readonly listeners = new Set<() => void>();
  private inFlight = false;
  private disposed = false;
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  /** Read the stable React external-store snapshot. */
  getSnapshot = (): RuntimeHealthState => this.state;

  /** Subscribe until the returned disposer runs. */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  /** Ignore late responses after plugin unload without issuing a request. */
  dispose(): void { this.disposed = true; this.listeners.clear(); }

  private set(value: Partial<RuntimeHealthState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }

  /** Read component health; every failure leaves the layer unobserved instead of inventing a value. */
  async refresh(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    this.set({ loading: true });
    try {
      const response = await this.request('/api/clawmaster/runtime', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        this.set({ observed: false, available: false, components: null, disabled: [], refused: response.status === 403, observedAt: null });
        return;
      }
      const parsed = view.safeParse(await response.json());
      this.set(parsed.success
        ? { observed: true, available: parsed.data.available, components: parsed.data.components,
          disabled: parsed.data.disabledPlugins, refused: false, observedAt: parsed.data.observedAt }
        : { observed: false, available: false, components: null, disabled: [], refused: false, observedAt: null });
    } catch {
      // An unreachable route and a refused one are different facts, so neither is read as observed.
      this.set({ observed: false, available: false, components: null, disabled: [], refused: false, observedAt: null });
    } finally {
      this.inFlight = false;
      this.set({ loading: false });
    }
  }
}
