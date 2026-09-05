/**
 * @license
 * Copyright 2026 ClawMaster contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionSummary } from './protocol.js';

/**
 * Product edition is not a runtime tool paywall. Personal users may use local
 * enterprise-grade tools with their own credentials. Organization data,
 * department profiles, park features and high-risk actions remain protected by
 * their existing identity, role, confirmation, policy and audit boundaries.
 */
export function runtimeToolExclusionsForEdition(
  edition: SessionSummary['productEdition'],
): string[] {
  const exclusions: Record<
    NonNullable<SessionSummary['productEdition']>,
    readonly string[]
  > = {
    personal: [],
    enterprise: [],
  };
  return [...exclusions[edition ?? 'personal']];
}
