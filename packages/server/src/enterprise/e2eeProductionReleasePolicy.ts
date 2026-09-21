/**
 * GENERATED FILE — E2EE production release policy.
 *
 * Regenerated from `security/e2ee-release-status.json` by the release
 * evidence pipeline; hand edits are overwritten. The candidate build ships
 * with the capability disabled: the production MLS advertisement requires
 * the external audit and two-role release approval recorded in the status
 * file (see scripts/verify-e2ee-release-readiness.mjs).
 */

export const e2eeProductionCapabilities = {
  enabled: false,
  protocolId: 'mls10-openmls-0.8-candidate',
  approvalDigest: null,
} as const
