/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { encode } from 'uqr';

/** Generates a QR matrix locally, without disclosing the payload to a third party. */
export function createQrMatrix(value: string): boolean[][] | null {
  try {
    const { data, size } = encode(value, {
      border: 1,
      boostEcc: false,
      ecc: 'L',
    });
    if (size < 23 || data.length !== size || data.some((row) => row.length !== size)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
