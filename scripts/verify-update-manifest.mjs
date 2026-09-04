#!/usr/bin/env node
/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */
import { verifyUpdateManifest } from '../packages/desktop/scripts/verify-update-manifest.mjs';

const [releaseDir = 'release', version] = process.argv.slice(2);
try {
  const result = verifyUpdateManifest({ releaseDir, version });
  console.log(`[verify-update-manifest] ok version=${result.version} assets=${result.assets.join(',')}`);
} catch (error) {
  console.error(`[verify-update-manifest] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
