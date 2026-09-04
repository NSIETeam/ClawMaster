/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { createQrMatrix } from './qrMatrix.js';

describe('createQrMatrix', () => {
  it('returns a deterministic square matrix with QR finder patterns', () => {
    const value = 'https://open.feishu.cn/open-apis/authen/v1/index?token=clawmaster';
    const first = createQrMatrix(value);
    const second = createQrMatrix(value);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first!.length).toBeGreaterThanOrEqual(21);
    expect(first!.every((row) => row.length === first!.length)).toBe(true);

    expect(first![0].every((cell) => cell === false)).toBe(true);
    expect(first!.at(-1)!.every((cell) => cell === false)).toBe(true);

    const firstFinder = 1;
    const lastFinder = first!.length - 8;
    for (const [row, column] of [
      [firstFinder, firstFinder],
      [firstFinder, lastFinder],
      [lastFinder, firstFinder],
    ]) {
      expect(first![row][column]).toBe(true);
      expect(first![row + 3][column + 3]).toBe(true);
      expect(first![row + 1][column + 1]).toBe(false);
    }
  });

  it('returns null instead of throwing when the payload cannot be encoded', () => {
    expect(createQrMatrix('x'.repeat(100_000))).toBeNull();
  });
});
