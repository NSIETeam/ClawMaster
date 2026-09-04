/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildVisualAssetInventory } from './visual-asset-inventory.mjs';

describe('desktop visual asset inventory', () => {
  it('classifies every tracked production asset and keeps compact surfaces theme-aware', async () => {
    const inventory = await buildVisualAssetInventory();
    expect(inventory.assets.length).toBeGreaterThan(0);
    expect(inventory.assets.filter((asset) =>
      asset.classification === 'unclassified'
        || asset.classification === 'inline-unregistered-svg')).toEqual([]);
    expect(inventory.assets.filter((asset) =>
      ['right-rail', 'module-launcher', 'expert-card'].includes(asset.context)
        && !asset.themeAware)).toEqual([]);
  });

  it('classifies the pairing QR as functional data rather than a decorative icon', async () => {
    const inventory = await buildVisualAssetInventory();
    expect(inventory.assets).toContainEqual(expect.objectContaining({
      file: 'src/renderer/components/hub/ChannelPairingCard.tsx',
      classification: 'functional-qr',
    }));
  });
});
