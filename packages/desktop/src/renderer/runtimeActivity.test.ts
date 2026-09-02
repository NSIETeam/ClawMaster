import { describe, expect, it } from 'vitest';
import { hasActiveRuntimeSession } from './runtimeActivity.js';

describe('hasActiveRuntimeSession', () => {
  it('keeps the runtime awake when any session is thinking or streaming', () => {
    expect(hasActiveRuntimeSession([
      { status: 'idle' },
      { status: 'streaming' },
    ])).toBe(true);
    expect(hasActiveRuntimeSession([{ status: 'thinking' }])).toBe(true);
  });

  it('releases the runtime guard when every session is idle or failed', () => {
    expect(hasActiveRuntimeSession([
      { status: 'idle' },
      { status: 'error' },
    ])).toBe(false);
  });
});
