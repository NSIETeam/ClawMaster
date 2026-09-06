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
});
