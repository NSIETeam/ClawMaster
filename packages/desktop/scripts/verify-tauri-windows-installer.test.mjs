import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSingleWindowsInstaller,
  verifyTauriWindowsInstaller,
} from './verify-tauri-windows-installer.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Tauri Windows installer verification', () => {
  it('selects one NSIS artifact and verifies its PE/archive contract', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'clawmaster-nsis-'));
    temporaryDirectories.push(directory);
    mkdirSync(directory, { recursive: true });
    const installer = path.join(directory, 'ClawMaster-preview-setup.exe');
    writeFileSync(installer, Buffer.from('MZportable-preview'));
    const testArchive = vi.fn();
    expect(resolveSingleWindowsInstaller(directory)).toBe(installer);
    expect(verifyTauriWindowsInstaller(installer, { testArchive }).withinTarget).toBe(true);
    expect(testArchive).toHaveBeenCalledWith(installer);
  });

  it('keeps installed startup, graceful exit, and orphan checks in release CI', () => {
    const smoke = readFileSync(
      path.join(import.meta.dirname, 'smoke-tauri-windows-install.ps1'),
      'utf8',
    );
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/tauri-preview.yml'),
      'utf8',
    );

    expect(smoke).toContain('$env:CLAWMASTER_USER_DIR = $userRoot');
    expect(smoke).toContain('$appProcess.CloseMainWindow()');
    expect(smoke).toContain('orphanProcessCount');
    expect(smoke).not.toContain('$env:OTTO_USER_DIR');
    expect(workflow).toContain('smoke-tauri-windows-install.ps1');
    expect(workflow).toContain('windows-installed-smoke.json');
    expect(workflow).toContain('CLAWMASTER_REAL_RPA_BROWSER: edge');
    expect(workflow).toContain('completes_real_browser_computer_use_with_encrypted_receipts');
    expect(workflow).toContain('windows-rpa-smoke.json');
  });
});
