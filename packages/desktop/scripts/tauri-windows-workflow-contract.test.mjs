import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NODE_RUNTIME_BUILD_FLAGS,
  WINDOWS_NODE_RUNTIME_BUILD_FLAGS,
} from './tauri-node-runtime-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeWorkflow = readFileSync(path.join(root, '.github/workflows/tauri-node-runtime.yml'), 'utf8');
const previewWorkflow = readFileSync(path.join(root, '.github/workflows/tauri-preview.yml'), 'utf8');
const installSmoke = readFileSync(
  path.join(root, 'packages/desktop/scripts/smoke-tauri-windows-install.ps1'),
  'utf8',
);

describe('Tauri Windows workflow contract', () => {
  it('produces a verified Windows x64 Node capsule', () => {
    expect(runtimeWorkflow).toMatch(/windows:\s*\n\s+name: win32-x64 balanced Node runtime/u);
    expect(runtimeWorkflow).toMatch(/repository: nodejs\/node/u);
    expect(runtimeWorkflow).toMatch(/ref: 71b8b174857e25106d39b61a9e6f30d927da8b01/u);
    expect(runtimeWorkflow).toContain(
      `vcbuild.bat ${WINDOWS_NODE_RUNTIME_BUILD_FLAGS.join(' ')}`,
    );
    expect(runtimeWorkflow).toContain('tauri-node-v5-win32-x64');
    expect(runtimeWorkflow).toMatch(/--binary node-source\/Release\/node\.exe/u);
    expect(runtimeWorkflow).toMatch(/--target win32-x64/u);
    expect(runtimeWorkflow).toMatch(/name: tauri-node-win32-x64/u);
  });

  it('keeps workflow build commands synchronized with the verified runtime profile', () => {
    for (const flag of NODE_RUNTIME_BUILD_FLAGS) {
      expect(runtimeWorkflow).toContain(`            ${flag}`);
    }
    expect(runtimeWorkflow).toContain(
      `run: vcbuild.bat ${WINDOWS_NODE_RUNTIME_BUILD_FLAGS.join(' ')}`,
    );
  });

  it('waits for and downloads the matching Node capsule before packaging', () => {
    expect(previewWorkflow).toMatch(/windows-x64:[\s\S]*?needs: \[native-assets, node-runtime\]/u);
    expect(previewWorkflow).toMatch(/name: tauri-node-win32-x64[\s\S]*?path: native\/node-runtime\/win32-x64/u);
  });

  it('installs into isolated storage and proves the packaged runtime can start', () => {
    expect(previewWorkflow).toContain('smoke-tauri-windows-install.ps1');
    expect(installSmoke).toContain("@('/S', \"/D=$installRoot\")");
    expect(installSmoke).toContain('verify-tauri-bundle.mjs');
    expect(installSmoke).toContain('$env:OTTO_USER_DIR = $userRoot');
    expect(installSmoke).toContain('if ($appProcess.HasExited)');
    expect(installSmoke).toContain('Remove-Item -LiteralPath $smokeRoot');
  });
});
