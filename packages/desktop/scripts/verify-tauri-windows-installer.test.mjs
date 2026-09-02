import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
