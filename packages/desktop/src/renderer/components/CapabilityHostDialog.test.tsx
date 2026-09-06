import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityHostDialog } from './CapabilityHostDialog.js';

describe('CapabilityHostDialog', () => {
  it('shows zero cold workers and requires confirmation before uninstall', async () => {
    const capabilityList = vi.fn().mockResolvedValue([{
      manifest: {
        schemaVersion: 1,
        id: 'team.nsi.office',
        version: '1.0.0',
        apiVersion: 'clawmaster.capability.v1',
        platforms: ['macos'],
        architectures: ['aarch64'],
        entrypoint: 'worker.wasm',
        permissions: ['artifact:write'],
        dependencies: [],
        compressedSize: 1024,
        installedSize: 2048,
        sha256: '0'.repeat(64),
        minimumRuntimeVersion: '0.0.2',
        signature: { keyId: 'first-party', value: 'signature' },
      },
      enabled: true,
      installedAt: 1,
    }]);
    const capabilityResources = vi.fn().mockResolvedValue({
      activeAgents: 0,
      queuedAgents: 0,
      activeWorkers: 0,
      loadedImplementations: 0,
      trustedKeyCount: 0,
      maxOutputBytes: 1024 * 1024,
      maxEventQueue: 1000,
      maxTimeoutSeconds: 300,
    });
    const capabilityUninstall = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.clawmaster, {
      capabilityList,
      capabilityResources,
      capabilityUninstall,
    });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<CapabilityHostDialog open onClose={vi.fn()} />);
    expect(await screen.findByText(/已加载实现 0 · worker 0/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('未配置第一方签名信任根');
    expect(screen.getByText('OCR 识别')).toBeTruthy();
    expect(screen.getAllByText('不可安装').length).toBeGreaterThan(0);
    expect(screen.getByText(/artifact:write/).textContent).toContain('0.00 MiB');

    fireEvent.click(screen.getByRole('button', { name: '卸载' }));
    expect(capabilityUninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(capabilityUninstall).toHaveBeenCalledWith('team.nsi.office', true));
  });

  it('shows a verified plan before explicitly installing a user-selected package', async () => {
    const capabilityList = vi.fn().mockResolvedValue([]);
    const capabilityResources = vi.fn().mockResolvedValue({
      activeAgents: 0, queuedAgents: 0, activeWorkers: 0, loadedImplementations: 0,
      trustedKeyCount: 1, maxOutputBytes: 1024, maxEventQueue: 1000, maxTimeoutSeconds: 300,
    });
    const manifest = {
      schemaVersion: 1, id: 'team.nsi.ocr', version: '1.0.0',
      apiVersion: 'clawmaster.capability.v1', platforms: ['macos'], architectures: ['aarch64'],
      entrypoint: 'worker.wasm', permissions: ['artifact:write'], dependencies: [],
      compressedSize: 1024, installedSize: 2048, sha256: '0'.repeat(64),
      minimumRuntimeVersion: '0.0.2', signature: { keyId: 'first-party', value: 'signature' },
    };
    const selectFiles = vi.fn().mockResolvedValue(['/tmp/manifest.json', '/tmp/worker.wasm']);
    const readFilePath = vi.fn(async (path: string) => ({
      filePath: path,
      fileName: path.split('/').pop() || '',
      size: 1,
      mimeType: 'application/octet-stream',
      data: path.endsWith('.json') ? btoa(JSON.stringify(manifest)) : 'AGFzbQE=',
    }));
    const capabilityPlanInstall = vi.fn().mockResolvedValue({
      id: manifest.id, version: manifest.version, source: 'user-selected-file',
      compressedSize: 1024, installedSize: 2048, permissions: ['artifact:write'],
      dependencies: [],
    });
    const installed = { manifest, enabled: true, installedAt: 1 };
    const capabilityInstall = vi.fn().mockResolvedValue(installed);
    Object.assign(window.clawmaster, {
      capabilityList, capabilityResources, selectFiles, readFilePath,
      capabilityPlanInstall, capabilityInstall,
    });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<CapabilityHostDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '选择 manifest.json 与 WASM' }));
    expect(await screen.findByRole('article', { name: '能力安装计划' })).toBeTruthy();
    expect(capabilityPlanInstall).toHaveBeenCalledWith(manifest, 'user-selected-file');
    expect(capabilityInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));
    expect(capabilityInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));
    await waitFor(() => expect(capabilityInstall).toHaveBeenCalledWith(manifest, 'AGFzbQE=', true));
    expect(await screen.findByText(/team\.nsi\.ocr 1\.0\.0 已安装/)).toBeTruthy();
  });
});
