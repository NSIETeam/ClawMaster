/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformWorkspace } from './PlatformWorkspace.js';

describe('PlatformWorkspace', () => {
  const openExternal = vi.fn(async () => undefined);
  const platformWebviewOpen = vi.fn(async () => undefined);
  const platformWebviewSetBounds = vi.fn(async () => undefined);
  const platformWebviewReload = vi.fn(async () => undefined);
  const platformWebviewClose = vi.fn(async () => undefined);

  beforeEach(() => {
    openExternal.mockClear();
    platformWebviewOpen.mockClear();
    platformWebviewSetBounds.mockClear();
    platformWebviewReload.mockClear();
    platformWebviewClose.mockClear();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 640, y: 80, left: 640, top: 80, right: 1240, bottom: 760,
      width: 600, height: 680, toJSON: () => ({}),
    });
    (window as unknown as { clawmaster: { openExternal: typeof openExternal } }).clawmaster = {
      openExternal,
    };
  });

  it('asks for an endpoint without claiming HTTP deployments are invalid', () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: null }} />);
    expect(screen.getByRole('textbox', { name: '平台地址（优先 HTTPS）' })).toBeTruthy();
  });

  it('embeds the registered production endpoint in a native child webview', async () => {
    Object.assign(window.clawmaster, {
      platformWebviewOpen,
      platformWebviewSetBounds,
      platformWebviewReload,
      platformWebviewClose,
    });
    render(<PlatformWorkspace target={{ id: 'zhifang', label: '知访', url: 'https://47.116.30.60/' }} />);
    await waitFor(() => expect(platformWebviewOpen).toHaveBeenCalledWith(
      'https://47.116.30.60/',
      { x: 640, y: 80, width: 600, height: 680 },
    ));
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByText('已在 ClawMaster 内打开 知访。')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows an explicit transport warning and falls back for a legacy shell', async () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: 'http://8.141.8.31/' }} />);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('http://8.141.8.31/'));
    expect(screen.getByRole('alert').textContent).toContain('传输未加密');
    expect(screen.getByText(/不支持内置浏览器/u)).toBeTruthy();
  });
});
