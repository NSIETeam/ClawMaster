/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('requires an encrypted endpoint', () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: null }} />);
    expect(screen.getByRole('textbox', { name: 'HTTPS 平台地址' })).toBeTruthy();
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
      false,
    ));
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByText(/加密连接已建立/u)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('persists the per-platform remember-password preference and passes it to the webview', async () => {
    Object.assign(window.clawmaster, { platformWebviewOpen, platformWebviewClose });
    render(<PlatformWorkspace target={{ id: 'zhiliaohou', label: '知了猴', url: 'https://example.com/' }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /保持登录/u }));
    expect(window.localStorage.getItem('clawmaster.platform.zhiliaohou.remember-login')).toBe('true');
    await waitFor(() => expect(platformWebviewOpen).toHaveBeenCalledWith(
      'https://example.com/',
      { x: 640, y: 80, width: 600, height: 680 },
      true,
    ));
  });

  it('blocks an insecure remote endpoint without opening either browser', async () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: 'http://8.141.8.31/' }} />);
    expect(screen.getByRole('alert').textContent).toContain('已阻止');
    expect(openExternal).not.toHaveBeenCalled();
    expect(platformWebviewOpen).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '系统浏览器' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('textbox', { name: 'HTTPS 平台地址' })).toBeTruthy();
  });

  it('does not save an insecure remote endpoint', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: null }} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'HTTPS 平台地址' }), { target: { value: 'http://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));
    expect(screen.getByRole('alert').textContent).toContain('必须使用 HTTPS');
    expect(setItem).not.toHaveBeenCalled();
  });
});
