import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  bindSidecarToParentPipe,
  isExpectedParentAlive,
  removeOwnedEndpoint,
} from './sidecar-parent-lifetime.mjs';

const moduleUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'sidecar-parent-lifetime.mjs'),
).href;

describe('Tauri sidecar parent lifetime', () => {
  it('exits once when the desktop-owned pipe reaches EOF', () => {
    const input = new PassThrough();
    const exit = vi.fn();
    bindSidecarToParentPipe({ input, exit });

    input.end();
    input.emit('close');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('removes only the endpoint owned by the exiting sidecar', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'clawmaster-parent-endpoint-'));
    const endpoint = path.join(root, 'server-endpoint.json');
    try {
      writeFileSync(endpoint, JSON.stringify({ pid: 42, clientToken: 'redacted' }));
      expect(removeOwnedEndpoint(endpoint, 43)).toBe(false);
      expect(JSON.parse(readFileSync(endpoint, 'utf8')).pid).toBe(42);
      expect(removeOwnedEndpoint(endpoint, 42)).toBe(true);
      expect(removeOwnedEndpoint(endpoint, 42)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can be detached during an orderly shutdown', () => {
    const input = new PassThrough();
    const exit = vi.fn();
    const detach = bindSidecarToParentPipe({ input, exit });

    detach();
    input.end();

    expect(exit).not.toHaveBeenCalled();
  });

  it('rejects a reparented or missing desktop even when the stdin pipe remains open', () => {
    expect(isExpectedParentAlive(42, { currentParentPid: 1, probe: vi.fn() })).toBe(false);
    expect(isExpectedParentAlive(42, { currentParentPid: 42, probe: vi.fn() })).toBe(true);
    expect(isExpectedParentAlive(42, {
      currentParentPid: 42,
      probe: () => { throw new Error('missing'); },
    })).toBe(false);
  });

  it('terminates a real child process when its parent closes the pipe', async () => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', `import { bindSidecarToParentPipe } from ${JSON.stringify(moduleUrl)}; bindSidecarToParentPipe();`],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.stdin.end();
    const result = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('guarded child did not exit')), 2_000)),
    ]);

    expect(result).toEqual({ code: 0, signal: null });
    expect(stderr).toBe('');
  });
});
