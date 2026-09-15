/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

// Bridge from the DSH host half to the recovered native helper.
//
// The recovered control plane is a command-line program: `<helper> --native-tool
// <name> [args...]` prints JSON on stdout and, on failure, a human-readable
// reason on stderr with exit code 2. This module owns invocation only. It does
// not inspect or rewrite payloads, and it never composes a coordinate: the
// recovered contract keeps raw input and element resolution inside the helper.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How to launch the helper. Tests inject a stand-in command. */
export interface NativeHelperSpec {
  command: string;
  args: readonly string[];
}

export interface NativeHelperConfig {
  helper?: NativeHelperSpec;
  timeoutMs?: number;
}

/** A failed native invocation, carrying the helper's own reason text. */
export class NativeHelperError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'NativeHelperError';
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the helper next to this component.
 *
 * @returns The platform's packaged binary, a local release/debug build, or null.
 */
export function defaultHelperPath(): string | null {
  const binary = `clawmaster-rpa-native${process.platform === 'win32' ? '.exe' : ''}`;
  const packaged = path.resolve(HERE, '..', 'dist', 'native', `${process.platform}-${process.arch}`, binary);
  if (existsSync(packaged) && lstatSync(packaged).isFile()) return packaged;
  for (const profile of ['release', 'debug']) {
    const candidate = path.resolve(HERE, '..', 'native', 'target', profile, binary);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Resolve the helper launch spec.
 *
 * @param configured Operator-supplied spec, which wins over detection.
 * @returns The spec to use, or null when no helper has been built.
 */
export function resolveHelperSpec(configured?: NativeHelperSpec): NativeHelperSpec | null {
  if (configured) return configured;
  const detected = defaultHelperPath();
  return detected ? { command: detected, args: [] } : null;
}

export interface NativeHelper {
  readonly spec: NativeHelperSpec;
  /**
   * Invoke one native subcommand.
   *
   * @param command The `--native-tool` name.
   * @param args Positional arguments after the subcommand.
   * @param signal Cancels the child when it fires.
   * @returns The parsed JSON payload printed on stdout.
   */
  run(command: string, args?: readonly string[], signal?: AbortSignal): Promise<unknown>;
}

/** Only operating-system discovery and locale variables reach the helper. */
const HELPER_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Build a helper client.
 *
 * @param spec How to launch the helper.
 * @param timeoutMs Wall-clock bound for one invocation.
 * @returns A client with bounded output; cancellation rejects only after its child has exited.
 */
export function createNativeHelper(spec: NativeHelperSpec, timeoutMs = 30_000): NativeHelper {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Native helper timeout must be an integer from 1 to 120000 milliseconds.');
  }
  return {
    spec,
    run(command, args = [], signal) {
      return new Promise<unknown>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new NativeHelperError('Native invocation was cancelled before it started.', command, null));
          return;
        }

        const child = spawn(spec.command, [...spec.args, '--native-tool', command, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => HELPER_ENV.has(key.toUpperCase()))),
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let failure: NativeHelperError | undefined;
        let settled = false;
        const finish = (error: Error | null, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value);
        };

        const timer = setTimeout(() => {
          failure ??= new NativeHelperError(`Native invocation timed out after ${timeoutMs}ms: ${command}`, command, null);
          child.kill('SIGKILL');
        }, timeoutMs);

        const onAbort = (): void => {
          failure ??= new NativeHelperError(`Native invocation was cancelled: ${command}`, command, null);
          child.kill('SIGKILL');
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            failure ??= new NativeHelperError('Native helper stdout exceeded the output limit.', command, null);
            child.kill('SIGKILL');
          } else if (!failure) stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > MAX_STDERR_BYTES) {
            failure ??= new NativeHelperError('Native helper stderr exceeded the output limit.', command, null);
            child.kill('SIGKILL');
          } else if (!failure) stderr.push(chunk);
        });

        child.on('error', (error) => {
          failure ??= new NativeHelperError(`Native helper could not start: ${error.message}`, command, null);
        });

        child.on('close', (code) => {
          if (failure) { finish(failure); return; }
          const message = Buffer.concat(stderr).toString('utf8').trim();
          if (code !== 0) {
            finish(new NativeHelperError(message || `Native helper exited with code ${String(code)}.`, command, code));
            return;
          }
          try {
            finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown);
          } catch {
            finish(new NativeHelperError('Native helper returned a payload that is not JSON.', command, code));
          }
        });
      });
    },
  };
}
