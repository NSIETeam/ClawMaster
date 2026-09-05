/**
 * @license
 * Copyright 2026 ClawMaster contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { runtimeToolExclusionsForEdition } from './sessionRuntimePolicy.js';

describe('runtimeToolExclusionsForEdition', () => {
  it.each(['personal', 'enterprise'] as const)(
    'does not apply a product-edition paywall to %s sessions',
    (edition) => {
      expect(runtimeToolExclusionsForEdition(edition)).toEqual([]);
    },
  );

  it('treats legacy sessions without an edition as personal and unlocked', () => {
    expect(runtimeToolExclusionsForEdition(undefined)).toEqual([]);
  });
});
