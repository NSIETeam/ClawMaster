import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Rust runtime-kernel CLI/server test adapter', () => {
  it('runs the readonly lifecycle through the same crate used by Tauri', () => {
    const manifest = fileURLToPath(
      new URL('../../runtime-kernel-rs/Cargo.toml', import.meta.url),
    );
    const result = spawnSync(
      'cargo',
      [
        'run',
        '--quiet',
        '--offline',
        '--manifest-path',
        manifest,
        '--bin',
        'clawmaster-kernel-test-adapter',
        '--',
        'readonly-loop',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      turn: { state: string; tools: Record<string, { state: string }> };
      events: Array<{ state: string }>;
    };
    expect(output.turn.state).toBe('completed');
    expect(output.turn.tools['call-1']?.state).toBe('success');
    expect(output.events.map((event) => event.state)).toEqual(
      expect.arrayContaining([
        'planning',
        'scheduled',
        'executing',
        'success',
        'observing_result',
        'writing_memory',
        'checkpointing',
        'completed',
      ]),
    );
  });
});
