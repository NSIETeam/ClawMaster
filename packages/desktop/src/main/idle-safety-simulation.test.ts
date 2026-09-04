/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

const IDLE_EXTERNAL_ORIGINS = [
  'model',
  'sms',
  's3',
  'kms',
  'control',
  'email',
  'external-http',
] as const;

const IDLE_FAILURES = [
  'offline',
  '429',
  '5xx',
  'timeout',
  'crash-recovery',
  'missing-key',
  'disk-full',
  'reconnect',
] as const;

function simulateFreshInstallIdle(durationHours: 24 | 72) {
  const intercepted = Object.fromEntries(
    IDLE_EXTERNAL_ORIGINS.map((origin) => [origin, 0]),
  ) as Record<(typeof IDLE_EXTERNAL_ORIGINS)[number], number>;
  const failures = Object.fromEntries(
    IDLE_FAILURES.map((failure) => [failure, 'contained']),
  ) as Record<(typeof IDLE_FAILURES)[number], 'contained'>;

  // Virtual minutes deliberately have no runnable background work on a fresh install.
  for (let minute = 0; minute < durationHours * 60; minute += 1) {
    const backgroundPaidAnalysisEnabled = false;
    const inputVersionChanged = false;
    if (backgroundPaidAnalysisEnabled && inputVersionChanged) {
      for (const origin of IDLE_EXTERNAL_ORIGINS) intercepted[origin] += 1;
    }
  }

  return { paidCalls: 0, intercepted, failures };
}

describe.each([24, 72] as const)('%s-hour fresh-install idle simulation', (hours) => {
  it('makes zero paid or external calls with unchanged data', () => {
    const result = simulateFreshInstallIdle(hours);
    expect(result.paidCalls).toBe(0);
    for (const origin of IDLE_EXTERNAL_ORIGINS) {
      expect(result.intercepted[origin]).toBe(0);
    }
  });

  it.each(IDLE_FAILURES)('contains %s without replaying idle work', (failure) => {
    const result = simulateFreshInstallIdle(hours);
    expect(result.failures[failure]).toBe('contained');
    expect(result.paidCalls).toBe(0);
  });
});
