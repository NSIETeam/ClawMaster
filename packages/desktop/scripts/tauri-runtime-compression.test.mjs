import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
describe('native-local runtime contract', () => {
  it('does not ship or download a Node runtime capsule', async () => {
    const [policy, config, smoke] = await Promise.all([
      readFile(path.join(root, 'scripts/tauri-runtime-policy.mjs'), 'utf8'),
      readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
      readFile(path.join(root, 'scripts/smoke-tauri-agent-runtime.mjs'), 'utf8'),
    ]);
    expect(policy).toContain("'native-local'");
    expect(policy).toContain('allowsRuntimeDownload: false');
    expect(config).toContain('"resources": {}');
    expect(smoke).toContain('in-process native-local');
  });
});
