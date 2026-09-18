/**
 * The optional Stirling-PDF track, supervised.
 *
 * Two properties decide whether this is safe to hand a user:
 *
 * - **Nothing starts unless it was asked for.** The runtime is 270 MiB of Java on disk; a component that
 *   spawns a JVM at boot would tax everyone for a feature most documents never need.
 * - **A dead runtime is a fallback, not an error.** The built-in track works on its own, so when the
 *   optional one fails to start, exits, or stops answering, the supervisor reports that and retires;
 *   it does not retry forever and it never blocks a PDF operation that the built-in track can do.
 *
 * The process, the clock and the HTTP check are all injected, so the lifecycle is testable without a JVM.
 */

/** How long a stopping process is given to honour SIGTERM before it is killed, and to be seen exiting. */
const STOP_GRACE_MS = 2000;

/** The state the supervisor reports to the panel and the tool. */
export type TrackState =
  | { state: 'stopped' }
  | { state: 'starting'; since: number }
  | { state: 'ready'; port: number; since: number }
  | { state: 'failed'; reason: string; since: number };

/** What the supervisor needs from a child process. */
export interface SupervisedProcess {
  /** The process id, for logging and for showing the user something concrete. */
  readonly pid: number | undefined;
  /** Resolves once the process has exited, with its code when there is one. */
  exited(): Promise<{ code: number | null }>;
  /** Ask the process to stop; the supervisor escalates to a kill if it does not. */
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/** How to launch and check the runtime. */
export interface SupervisorOptions {
  /** Absolute path to the java binary the runtime should be launched with. */
  java: string;
  /** Absolute path to the jar. */
  jar: string;
  /** The port to bind, on the loopback interface only. */
  port: number;
  /** Extra JVM arguments, for a user who needs more heap. */
  javaArgs?: readonly string[];
  /** Arguments after the jar; the runtime defaults to binding 0.0.0.0, so the host is pinned. */
  appArgs?: readonly string[];
  /** How long to wait for the runtime to answer before declaring it failed. */
  readyTimeoutMs?: number;
  /** How often to ask. */
  pollIntervalMs?: number;
  /** How many times an unexpected exit may be restarted before giving up. */
  maxRestarts?: number;
  /** Launch one process. */
  spawn: (command: string, args: readonly string[]) => SupervisedProcess;
  /** Ask the runtime whether it is up. Injected so a test can answer without a server. */
  probe: (port: number, timeoutMs: number) => Promise<boolean>;
  /** Wait; injected so a test does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock, so the reported times are deterministic in a test. */
  now?: () => number;
  /** Called whenever the state changes, so the panel can follow along. */
  onState?: (state: TrackState) => void;
}

/** Why the runtime is unusable, when it is. */
export interface RuntimeFailure {
  reason: string;
  /** True when trying again later is worth the user's time. */
  retryable: boolean;
}

/**
 * Owns the optional runtime's process.
 *
 * One instance per component; `stop()` is idempotent and the supervisor is safe to call after a failure.
 */
export class StirlingSupervisor {
  private current: SupervisedProcess | undefined;
  private reported: TrackState = { state: 'stopped' };
  private restarts = 0;
  private stopping = false;
  private starting: Promise<TrackState> | undefined;
  private watcher: Promise<void> | undefined;

  constructor(private readonly options: SupervisorOptions) {}

  /** The last observed state. */
  get state(): TrackState {
    return this.reported;
  }

  /** True while a process is believed to be running. */
  get running(): boolean {
    return this.current !== undefined && !this.stopping;
  }

  /**
   * Start the runtime and wait until it answers, or until it is clear that it will not.
   * Repeating the call while starting returns the same promise rather than launching a second JVM.
   * @returns The resulting state.
   */
  async start(): Promise<TrackState> {
    if (this.reported.state === 'ready' && this.running) return this.reported;
    if (this.starting !== undefined) return await this.starting;
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** Stop the runtime and wait for the process to be gone. Idempotent. */
  async stop(): Promise<void> {
    await this.release();
    this.report({ state: 'stopped' });
  }

  /**
   * Retire the process and free the port, without publishing a state of its own.
   *
   * Kept apart from `stop()` because a failure that retires its own process must keep saying *why* it
   * failed: reporting `stopped` afterwards would replace "did not answer within 90s" with a state that
   * reads as though the user had never asked for the runtime.
   */
  private async release(): Promise<void> {
    const process = this.current;
    this.stopping = true;
    if (process !== undefined) {
      process.signal('SIGTERM');
      // A JVM that is mid-request may ignore a polite stop; a hard kill after a short grace is what
      // keeps the port from being held by a process the user cannot see.
      const code = await Promise.race([
        process.exited(),
        this.sleep(STOP_GRACE_MS).then(() => 'timeout' as const),
      ]);
      if (code === 'timeout') {
        try { process.signal('SIGKILL'); } catch { /* it may have exited between the two calls */ }
      }
      // The watcher exists only to decide whether an *unexpected* exit should be restarted, and
      // `stopping` above already answers that. Waiting for it without a bound would let a process that
      // never reports its exit hold the port open forever, and `launch()` releases on its ready
      // timeout, so that would leave `start()` unsettled too.
      await Promise.race([this.watcher ?? Promise.resolve(), this.sleep(STOP_GRACE_MS)]).catch(() => undefined);
    }
    this.current = undefined;
    this.stopping = false;
  }

  /** Launch once, watch the process, and wait for the health check. */
  private async launch(): Promise<TrackState> {
    const { java, jar, port, javaArgs = [], appArgs = [] } = this.options;
    const startedAt = this.now();
    this.report({ state: 'starting', since: startedAt });
    let child: SupervisedProcess;
    try {
      // The host is pinned to the loopback interface: the runtime's own default binds every interface,
      // and a document server that the whole network can reach is not what "optional local component"
      // should mean.
      child = this.options.spawn(java, [
        ...javaArgs,
        '-jar', jar,
        ...(appArgs.length > 0 ? appArgs : ['--server.address=127.0.0.1', `--server.port=${port}`]),
      ]);
    } catch (error) {
      const reason = `Could not launch the optional runtime: ${messageOf(error)}`;
      this.report({ state: 'failed', reason, since: startedAt });
      return this.reported;
    }
    this.current = child;
    this.watch(child);

    const deadline = startedAt + (this.options.readyTimeoutMs ?? 90_000);
    while (this.now() < deadline) {
      if (this.current !== child) return this.reported;
      if (await this.probeOnce()) {
        this.report({ state: 'ready', port, since: this.now() });
        return this.reported;
      }
      await this.sleep(this.options.pollIntervalMs ?? 1000);
    }
    const reason = `The optional runtime did not answer on 127.0.0.1:${port} within ${Math.round((this.options.readyTimeoutMs ?? 90_000) / 1000)}s.`;
    this.report({ state: 'failed', reason, since: this.now() });
    // A runtime that never became ready is of no use held open; releasing it also frees the port. The
    // failure above stays reported, so the panel can still say why the optional track is unavailable.
    await this.release().catch(() => undefined);
    return this.reported;
  }

  /** One health check, reported as unavailable rather than thrown. */
  private async probeOnce(): Promise<boolean> {
    try {
      return await this.options.probe(this.options.port, Math.min(2000, this.options.pollIntervalMs ?? 1000));
    } catch {
      return false;
    }
  }

  /** Follow a process: an unexpected exit either restarts it or retires the track. */
  private watch(child: SupervisedProcess): void {
    this.watcher = child.exited().then(async ({ code }) => {
      if (this.stopping || this.current !== child) return;
      this.current = undefined;
      const limit = this.options.maxRestarts ?? 2;
      if (this.restarts >= limit) {
        this.report({
          state: 'failed',
          reason: `The optional runtime exited (${code === null ? 'no exit code' : `code ${code}`}) and had already been restarted ${this.restarts} time(s); the built-in PDF tools still work.`,
          since: this.now(),
        });
        return;
      }
      this.restarts += 1;
      this.report({ state: 'failed', reason: `The optional runtime exited (${code === null ? 'no exit code' : `code ${code}`}); restarting (attempt ${this.restarts}).`, since: this.now() });
      await this.launch();
    }).catch(() => undefined);
  }

  /** Record and publish a state. */
  private report(state: TrackState): void {
    this.reported = state;
    this.options.onState?.(state);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** A reason for a failure that the panel can show. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The default health check: ask the runtime for its front page.
 * Stirling-PDF serves its UI at `/`, so an answering root on the loopback interface is the cheapest
 * honest signal that the JVM finished starting; a connection refused or a non-2xx is not.
 * @param port - The loopback port the runtime was told to bind.
 * @param timeoutMs - How long one check may take.
 * @returns True when the runtime answered.
 */
export async function probeStirlingHttp(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: 'manual' });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Launch a child process with `node:child_process`.
 * Kept as a separate function so the supervisor's tests never need a real JVM.
 * @param command - The executable.
 * @param args - Its arguments.
 * @returns The supervised handle.
 */
export async function createStirlingSpawner(): Promise<(command: string, args: readonly string[]) => SupervisedProcess> {
  // The import happens here rather than at module scope so the module can be imported for its types
  // without pulling node:child_process into a bundle that never spawns anything.
  const { spawn } = await import('node:child_process');
  return (command, args) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<{ code: number | null }>(resolve => {
      child.once('exit', code => resolve({ code }));
      child.once('error', () => resolve({ code: null }));
    });
    return {
      pid: child.pid,
      exited: () => exited,
      signal: signal => { child.kill(signal); },
    };
  };
}
