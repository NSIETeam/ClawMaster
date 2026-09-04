/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode } from './QrCode.js';

describe('QrCode', () => {
  it('renders one accessible, reusable SVG surface', () => {
    render(
      <QrCode
        value="https://open.feishu.cn/open-apis/authen/v1/index?token=clawmaster"
        label="连接二维码"
        className="test-qr"
      />,
    );

    const image = screen.getByRole('img', { name: '连接二维码' });
    expect(image.getAttribute('class')).toBe('test-qr');
    expect(image.getAttribute('viewBox')).toMatch(/^-3 -3 \d+ \d+$/u);
    expect(image.querySelector('path')?.getAttribute('d')).toContain('M');
  });

  it('renders nothing for an unencodable payload', () => {
    const { container } = render(
      <QrCode value={'x'.repeat(100_000)} label="无效二维码" />,
    );
    expect(container.innerHTML).toBe('');
  });
});
