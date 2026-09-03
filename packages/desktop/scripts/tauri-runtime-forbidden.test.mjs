import { describe, expect, it } from 'vitest';
import { assertNoTauriRuntimePackageManagers } from './tauri-runtime-forbidden.mjs';

describe('Tauri runtime forbidden payload guard', () => {
  it('accepts the minimal ClawMaster runtime layout', () => {
    expect(assertNoTauriRuntimePackageManagers([
      'agent/bootstrap.mjs',
      'agent/agent.br',
      'node/node.br',
      'sqlcipher/better_sqlite3.node',
    ])).toBe(true);
  });

  it('rejects package managers, Electron tooling, and build caches', () => {
    expect(() => assertNoTauriRuntimePackageManagers([
      'agent/node_modules/npm/bin/npm-cli.js',
      'agent/node_modules/electron/dist/Electron.app',
      'agent/node_modules/@otto/native/target/release/build-cache',
      'node/.cache/native.tar',
    ])).toThrow(/must not package npm, package managers, Electron tooling, or build caches/u);
  });
});
