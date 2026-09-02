/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelPairingCard } from './ChannelPairingCard.js';

const basePairing = {
  pairingId: 'pair_0123456789abcdef01234567',
  provider: 'feishu' as const,
  status: 'user_authorized' as const,
  qrPayload: '',
  expiresAtMs: Date.now() + 300_000,
  requestedScopes: ['im:message'],
  tenantName: '示例企业',
};

describe('ChannelPairingCard', () => {
  const channelPairingBegin = vi.fn();
  const channelPairingInstall = vi.fn();

  beforeEach(() => {
    channelPairingBegin.mockReset();
    channelPairingInstall.mockReset();
    (window as unknown as { otto: unknown }).otto = {
      channelPairingBegin,
      channelPairingInstall,
      channelPairingStatus: vi.fn(),
      channelPairingCancel: vi.fn(),
      openExternal: vi.fn(),
    };
  });

  it('does not pretend pairing succeeded when the provider connector is absent', async () => {
    channelPairingBegin.mockResolvedValue({
      ok: false,
      pairing: null,
      error: 'channel_connector_unavailable:wecom',
    });
    render(<ChannelPairingCard provider="wecom" />);

    fireEvent.click(screen.getByRole('button', { name: '生成企业微信连接二维码' }));

    expect((await screen.findByRole('alert')).textContent).toContain('扫码服务尚未安装');
    expect(screen.queryByRole('img', { name: '企业微信连接二维码' })).toBeNull();
  });

  it('shows the verified tenant and permissions before manual installation', async () => {
    channelPairingBegin.mockResolvedValue({ ok: true, pairing: basePairing, error: null });
    channelPairingInstall.mockResolvedValue({ ok: true, data: { installationId: 'install-1' }, error: null });
    render(<ChannelPairingCard provider="feishu" />);

    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));
    expect(await screen.findByText('企业：示例企业')).toBeTruthy();
    expect(screen.getByText('权限：im:message')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认权限并安装' }));
    await waitFor(() => expect(channelPairingInstall).toHaveBeenCalledWith(basePairing.pairingId));
    expect(await screen.findByText('机器人连接成功。')).toBeTruthy();
  });

  it('waits for provider-confirmed admin approval without a local bypass button', async () => {
    channelPairingBegin.mockResolvedValue({
      ok: true,
      pairing: { ...basePairing, status: 'waiting_admin' },
      error: null,
    });
    render(<ChannelPairingCard provider="feishu" />);
    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));

    expect(await screen.findByText('平台要求企业管理员批准，批准后才能安装。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '管理员已批准' })).toBeNull();
  });
});
