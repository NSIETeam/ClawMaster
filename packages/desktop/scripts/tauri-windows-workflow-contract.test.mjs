import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
describe('cross-platform Tauri workflow contract', () => {
  it('uses Node 24-native official GitHub Actions throughout CI and release workflows', async () => {
    const workflows = await Promise.all([
      'ci.yml',
      'tauri-preview.yml',
      'rpa-browser-e2e.yml',
    ].map((name) => readFile(path.join(root, '.github/workflows', name), 'utf8')));
    const source = workflows.join('\n');
    expect(source).not.toMatch(/actions\/(?:checkout|setup-node)@v[1-6]\b/u);
    expect(source).not.toMatch(/actions\/(?:upload-artifact|download-artifact)@v[1-4]\b/u);
    expect(source).not.toContain("node-version: '22.13.0'");
    expect(source).toContain('actions/checkout@v7');
    expect(source).toContain('actions/setup-node@v7');
    expect(source).toContain('actions/upload-artifact@v7');
    expect(source).toContain('actions/download-artifact@v8');
  });

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
    expect(workflow).not.toContain('tauri-node-${{ matrix.runtime }}');
    expect(workflow).not.toContain('tauri-sqlcipher-${{ matrix.runtime }}');
    expect(workflow).toContain('Reject legacy packaged runtimes');
  });

  it('publishes only a version-matched tag from the exact latest main commit', async () => {
    const workflow = await readFile(path.join(root, '.github/workflows/tauri-preview.yml'), 'utf8');
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).toContain('test "$GITHUB_REF_NAME" = "v${version}"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"');
    expect(workflow).toContain('tag_name: ${{ github.ref_name }}');
    expect(workflow).toContain('name: ClawMaster ${{ github.ref_name }}');
    expect(workflow).not.toContain('inputs.publish_release');
    expect(workflow).not.toContain('prerelease: true');
  });
});
