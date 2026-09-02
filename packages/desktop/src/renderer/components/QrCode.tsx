/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useMemo } from 'react';
import { createQrMatrix } from '../lib/qrMatrix.js';

export interface QrCodeProps {
  value: string;
  label: string;
  className?: string;
}

export function QrCode({ value, label, className }: QrCodeProps): React.JSX.Element | null {
  const matrix = useMemo(() => createQrMatrix(value), [value]);
  if (!matrix) return null;

  const path: string[] = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      if (row[x] && start < 0) start = x;
      if ((!row[x] || x === row.length) && start >= 0) {
        path.push(`M${start} ${y}h${x - start}v1H${start}z`);
        start = -1;
      }
    }
  });

  const size = matrix.length;
  return (
    <svg
      className={className}
      role="img"
      aria-label={label}
      viewBox={`-3 -3 ${size + 6} ${size + 6}`}
      shapeRendering="crispEdges"
    >
      <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#fff" />
      <path d={path.join('')} fill="#111" />
    </svg>
  );
}
