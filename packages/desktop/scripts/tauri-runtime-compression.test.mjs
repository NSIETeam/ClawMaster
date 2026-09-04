import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
describe('native-local runtime contract', () => {
  it('ships the verified local sidecar without runtime downloads', async () => {
    const [policy, config, smoke] = await Promise.all([
      readFile(path.join(root, 'scripts/tauri-runtime-policy.mjs'), 'utf8'),
      readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
      readFile(path.join(root, 'scripts/smoke-tauri-agent-runtime.mjs'), 'utf8'),
    ]);
    expect(policy).toContain("'native-local'");
    expect(policy).toContain('allowsRuntimeDownload: false');
    expect(config).toContain('sidecar-staging/runtime/agent');
    expect(config).toContain('sidecar-staging/runtime/node');
    expect(config).toContain('sidecar-staging/runtime/sqlcipher');
    expect(smoke).toContain('slash command discovery timed out');
    expect(smoke).toContain("['plan', 'goal', 'system', 'init']");
  });
});
