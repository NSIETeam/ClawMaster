/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelInstallationList } from './ChannelInstallationList.js';

const installation = {
  installationId: 'channel_wecom_0123456789abcdef01234567',
  provider: 'wecom' as const,
  tenantId: 'corp-1',
  tenantName: '示例企业',
  botName: 'ClawMaster Bot',
  grantedScopes: ['message.send'],
  connectedAtMs: 1,
};

describe('ChannelInstallationList', () => {
  const channelInstallations = vi.fn();
  const channelInstallationAction = vi.fn();

  beforeEach(() => {
    channelInstallations.mockReset().mockResolvedValue({
      ok: true,
      data: [installation],
      error: null,
    });
    channelInstallationAction.mockReset().mockImplementation(
      async (_id: string, action: string) => action === 'health'
        ? {
            ok: true,
            data: {
              installationId: installation.installationId,
              running: true,
              state: 'connected',
              reconnectCount: 1,
            },
            error: null,
          }
        : { ok: true, data: action === 'revoke' ? { revoked: true } : {}, error: null },
    );
    (window as unknown as { clawmaster: unknown }).clawmaster = {
      channelInstallations,
      channelInstallationAction,
    };
  });

  it('shows verified tenant, permissions and live health from the shared supervisor', async () => {
    render(<ChannelInstallationList provider="wecom" />);

    expect(await screen.findByText('ClawMaster Bot')).toBeTruthy();
    expect(screen.getByText('示例企业')).toBeTruthy();
    expect(screen.getByText(/权限：message.send · 重连 1 次/)).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(channelInstallationAction).toHaveBeenCalledWith(
      installation.installationId,
      'health',
    );
  });

  it('requires a second click before revoking an installation', async () => {
    render(<ChannelInstallationList provider="wecom" />);
    const revoke = await screen.findByRole('button', { name: '注销连接' });
    fireEvent.click(revoke);
    expect(channelInstallationAction).not.toHaveBeenCalledWith(
      installation.installationId,
      'revoke',
    );
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认注销' }));
    await waitFor(() => expect(channelInstallationAction).toHaveBeenCalledWith(
      installation.installationId,
      'revoke',
    ));
  });
});
