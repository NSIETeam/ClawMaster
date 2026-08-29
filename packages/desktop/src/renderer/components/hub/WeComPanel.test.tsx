/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WECOM_ADMIN_URL, WECOM_API_GUIDE_URL, WeComPanel } from './WeComPanel.js';

describe('WeComPanel', () => {
  const openExternal = vi.fn(async () => undefined);

  beforeEach(() => {
    openExternal.mockReset();
    (window as unknown as { otto: { openExternal: typeof openExternal } }).otto = { openExternal };
  });

  it('opens only the fixed official WeCom destinations', async () => {
    render(<WeComPanel />);

    fireEvent.click(screen.getByRole('button', { name: /打开企业微信管理后台/ }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(WECOM_ADMIN_URL));

    fireEvent.click(screen.getByRole('button', { name: /查看官方接入说明/ }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(WECOM_API_GUIDE_URL));
  });

  it('shows an actionable error when desktop navigation fails', async () => {
    openExternal.mockRejectedValueOnce(new Error('system browser unavailable'));
    render(<WeComPanel />);

    fireEvent.click(screen.getByRole('button', { name: /打开企业微信管理后台/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('system browser unavailable');
  });
});
