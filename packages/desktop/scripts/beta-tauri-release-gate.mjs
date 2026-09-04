#!/usr/bin/env node

import { evaluateFormalTauriReleaseGate } from './formal-tauri-release-gate.mjs';

const result = evaluateFormalTauriReleaseGate({
  allowPrerelease: true,
  packagingMode: process.env.CLAWMASTER_PACKAGING_MODE || 'native-local',
});

if (result.failures.length) {
  console.error('[beta-tauri-release-gate] failed');
  for (const failure of result.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[beta-tauri-release-gate] ok');
for (const message of result.notes) console.log(`[beta-tauri-release-gate] note: ${message}`);
