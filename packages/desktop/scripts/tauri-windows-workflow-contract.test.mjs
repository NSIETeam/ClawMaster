import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NODE_RUNTIME_BUILD_FLAGS,
  WINDOWS_NODE_RUNTIME_DISTRIBUTION,
} from './tauri-node-runtime-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeWorkflow = readFileSync(path.join(root, '.github/workflows/tauri-node-runtime.yml'), 'utf8');
const windowsRuntimeJob = runtimeWorkflow.slice(runtimeWorkflow.indexOf('\n  windows:'));
const previewWorkflow = readFileSync(path.join(root, '.github/workflows/tauri-preview.yml'), 'utf8');
const sqlcipherWorkflow = readFileSync(path.join(root, '.github/workflows/sqlcipher-native.yml'), 'utf8');
const installSmoke = readFileSync(
  path.join(root, 'packages/desktop/scripts/smoke-tauri-windows-install.ps1'),
  'utf8',
);

describe('Tauri Windows workflow contract', () => {
  it('allows isolated Windows candidate branches to trigger preview validation', () => {
    expect(previewWorkflow).toContain("branches: [main, 'codex/windows-*']");
  });

  it('produces a verified Windows x64 Node capsule', () => {
    expect(runtimeWorkflow).toMatch(/windows:\s*\n\s+name: win32-x64 balanced Node runtime/u);
    expect(runtimeWorkflow).toMatch(/windows:\s*[\s\S]*?runs-on: windows-2022/u);
    expect(runtimeWorkflow).toContain(WINDOWS_NODE_RUNTIME_DISTRIBUTION.url);
    expect(runtimeWorkflow).toContain(WINDOWS_NODE_RUNTIME_DISTRIBUTION.sha256);
    expect(runtimeWorkflow).toContain('Get-FileHash $archivePath -Algorithm SHA256');
    expect(runtimeWorkflow).toContain('tauri-node-v7-win32-x64');
    expect(runtimeWorkflow).toMatch(/--binary .*node-v24\.20\.0-win-x64\/node\.exe/u);
    expect(runtimeWorkflow).toMatch(/--target win32-x64/u);
    expect(runtimeWorkflow).toMatch(/name: tauri-node-win32-x64/u);
    expect(windowsRuntimeJob).not.toContain('vcbuild.bat');
    expect(windowsRuntimeJob).not.toContain('repository: nodejs/node');
  });

  it('keeps workflow build commands synchronized with the verified runtime profile', () => {
    for (const flag of NODE_RUNTIME_BUILD_FLAGS) {
      expect(runtimeWorkflow).toContain(`            ${flag}`);
    }
    expect(runtimeWorkflow).toContain(WINDOWS_NODE_RUNTIME_DISTRIBUTION.archive);
  });

  it('pins every active Windows release stage to the stable Windows 2022 image', () => {
    expect(runtimeWorkflow).not.toContain('windows-2025');
    expect(sqlcipherWorkflow).toContain('runner: windows-2022');
    expect(sqlcipherWorkflow).not.toContain('windows-2025');
    expect(previewWorkflow).toContain('runs-on: windows-2022');
    expect(previewWorkflow).not.toContain('windows-2025');
  });

  it('installs the PE dependency inspector used by the SQLCipher verifier', () => {
    expect(previewWorkflow).toContain('uses: msys2/setup-msys2@v2');
    expect(previewWorkflow).toContain('mingw-w64-ucrt-x86_64-binutils');
  });

  it('waits for and downloads the matching Node capsule before packaging', () => {
    expect(previewWorkflow).toContain('windows_only: true');
    expect(previewWorkflow).toMatch(/windows-x64:[\s\S]*?needs: \[native-assets, node-runtime\]/u);
    expect(previewWorkflow).toMatch(/name: tauri-node-win32-x64[\s\S]*?path: native\/node-runtime\/win32-x64/u);
    expect(previewWorkflow).toContain('verify-tauri-node-runtime.mjs');
    expect(previewWorkflow).toContain(
      '--asset-directory native/node-runtime/win32-x64',
    );
    expect(previewWorkflow).toContain('verify-tauri-sqlcipher-asset.mjs');
    expect(previewWorkflow).toContain(
      '--asset-directory native/sqlcipher-tauri/win32-x64',
    );
  });

  it('does not gate the Windows release on macOS packages', () => {
    expect(previewWorkflow).not.toMatch(/\n  macos:\n/u);
    expect(previewWorkflow).toMatch(/publish:[\s\S]*?needs: windows-x64/u);
    expect(previewWorkflow).not.toContain('ClawMaster_*.dmg');
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
