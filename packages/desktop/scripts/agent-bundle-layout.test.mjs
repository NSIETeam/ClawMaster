import { describe, expect, it } from 'vitest';
import { evaluateAgentBundleLayout } from './agent-bundle-layout.mjs';

describe('Agent bundle layout', () => {
  it('accepts a small resident entry with deferred capability chunks', () => {
    expect(evaluateAgentBundleLayout({
      files: [
        { path: 'server.mjs', bytes: 1_800_000 },
        { path: 'chunks/shared-AAA.mjs', bytes: 100_000 },
        { path: 'chunks/pdf-ABC.mjs', bytes: 4_000_000 },
        { path: 'chunks/telemetry-DEF.mjs', bytes: 2_000_000 },
        { path: 'core-assets/skills-seed/example/SKILL.md', bytes: 100 },
      ],
    }, { outputs: {
      '/tmp/agent-payload/server.mjs': { imports: [{ path: 'chunks/shared-AAA.mjs', kind: 'import-statement' }] },
      '/tmp/agent-payload/chunks/shared-AAA.mjs': { imports: [] },
      '/tmp/agent-payload/chunks/pdf-ABC.mjs': { imports: [] },
      '/tmp/agent-payload/chunks/telemetry-DEF.mjs': { imports: [] },
    } })).toEqual({
      residentEntryBytes: 1_900_000,
      residentFileCount: 2,
      deferredChunkBytes: 6_000_000,
      deferredChunkCount: 2,
    });
  });

  it('rejects a monolithic Agent bundle', () => {
    expect(() => evaluateAgentBundleLayout({
      files: [{ path: 'server.mjs', bytes: 1_800_000 }],
    }, { outputs: { 'server.mjs': { imports: [] } } })).toThrow('deferred capability chunks');
  });

  it('rejects a resident entry that silently absorbs optional capabilities', () => {
    expect(() => evaluateAgentBundleLayout({
      files: [
        { path: 'server.mjs', bytes: 4 * 1024 * 1024 + 1 },
        { path: 'chunks/pdf-ABC.mjs', bytes: 10 },
      ],
    }, { outputs: {
      'server.mjs': { imports: [] },
      'chunks/pdf-ABC.mjs': { imports: [] },
    } })).toThrow('resident closure exceeds');
  });
});
