#!/usr/bin/env node
/**
 * Enterprise server binary entry point.
 *
 * Pins the release identity consumed by deployment/enterprise-oneclick
 * scripts (`CLAWMASTER_APP_VERSION`) and checked by the release
 * version-consistency gate; keep the literal aligned with the root
 * package.json version.
 */

export const CLAWMASTER_APP_VERSION = '0.1.5-rc.2'

export const CLAWMASTER_APP_VERSION_LINE = 'CLAWMASTER_APP_VERSION=0.1.5-rc.2'

if (process.env.CLAWMASTER_APP_VERSION === undefined) {
  process.env.CLAWMASTER_APP_VERSION = CLAWMASTER_APP_VERSION
}
