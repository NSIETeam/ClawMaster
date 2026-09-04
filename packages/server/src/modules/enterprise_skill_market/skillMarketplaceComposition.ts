/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { createEnterpriseSkillMarketplaceFacade } from './skillMarketplaceFacade.js';
import type { EnterpriseSkillMarketStore } from './skillMarketplaceRepository.js';

export function createEnterpriseSkillMarketplaceComposition(store: EnterpriseSkillMarketStore) {
  return createEnterpriseSkillMarketplaceFacade(store);
}
