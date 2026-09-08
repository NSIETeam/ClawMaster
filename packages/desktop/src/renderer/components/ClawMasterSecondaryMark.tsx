/**
 * @license
 * Copyright 2026 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ClawMasterMark } from './icons.js';

/**
 * 回复标记与桌面品牌位共用同一透明轮廓，不再维护第二套图形和颜色。
 */
export function ClawMasterSecondaryMark({
  active,
}: {
  active: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`claw-response-mark${active ? ' is-active' : ''}`}
      role={active ? 'status' : 'img'}
      aria-label={active ? 'ClawMaster 正在回答' : 'ClawMaster 回复'}
    >
      <ClawMasterMark size={24} decorative />
    </span>
  );
}
