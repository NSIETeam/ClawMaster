import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
describe('cross-platform Tauri workflow contract', () => {
  it('builds the supported matrix only after shared acceptance', async () => {
    const workflow = await readFile(path.join(root, '.github/workflows/tauri-preview.yml'), 'utf8');
    expect(workflow).toContain('needs: preflight');
    expect(workflow).toContain('windows-2022');
    expect(workflow).toContain('macos-15');
    expect(workflow).not.toContain('name: macOS-x64');
    expect(workflow).not.toContain('name: Linux-x64');
    expect(workflow).not.toContain('x86_64-apple-darwin');
    expect(workflow).not.toContain('x86_64-unknown-linux-gnu');
    expect(workflow).not.toContain('tauri-node-runtime.yml');
    expect(workflow).not.toContain('sqlcipher-native.yml');
  });
});
