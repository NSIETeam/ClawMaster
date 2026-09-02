/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlatformWorkspace } from './PlatformWorkspace.js';

describe('PlatformWorkspace', () => {
  it('loads the registered production endpoint without asking the user to configure it', () => {
    render(<PlatformWorkspace target={{ id: 'zhifang', label: '知访', url: 'https://47.116.30.60/' }} />);
    expect(screen.getByTitle('知访工作台').getAttribute('src')).toBe('https://47.116.30.60/');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows an explicit transport warning for a registered HTTP service', () => {
    render(<PlatformWorkspace target={{ id: 'maotouying', label: '猫头鹰', url: 'http://8.141.8.31/' }} />);
    expect(screen.getByTitle('猫头鹰工作台').getAttribute('src')).toBe('http://8.141.8.31/');
    expect(screen.getByRole('alert').textContent).toContain('传输未加密');
  });
});
