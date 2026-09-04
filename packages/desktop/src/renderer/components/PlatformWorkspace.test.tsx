/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformWorkspace } from './PlatformWorkspace.js';

describe('PlatformWorkspace', () => {
  const openExternal = vi.fn(async () => undefined);

  beforeEach(() => {
    openExternal.mockClear();
    (window as unknown as { clawmaster: { openExternal: typeof openExternal } }).clawmaster = {
      openExternal,
    };
  });

  it('asks for an endpoint without claiming HTTP deployments are invalid', () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: null }} />);
    expect(screen.getByRole('textbox', { name: '平台地址（优先 HTTPS）' })).toBeTruthy();
  });

  it('opens the registered production endpoint as a top-level browser page', async () => {
    render(<PlatformWorkspace target={{ id: 'zhifang', label: '知访', url: 'https://47.116.30.60/' }} />);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://47.116.30.60/'));
    expect(screen.queryByTitle('知访工作台')).toBeNull();
    expect(screen.getByText(/禁止 iframe 嵌入/u)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows an explicit transport warning for a registered HTTP service', async () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: 'http://8.141.8.31/' }} />);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('http://8.141.8.31/'));
    expect(screen.getByRole('alert').textContent).toContain('传输未加密');
  });
});
