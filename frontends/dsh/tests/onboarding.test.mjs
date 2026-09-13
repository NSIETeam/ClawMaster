import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeOnboarding } from '../src/onboarding.ts';
import { OnboardingSettingsSchema } from '../src/onboarding-host.ts';

test('tutorial settings reject malformed acknowledgements and preserve newer versions', () => {
  assert.deepEqual(OnboardingSettingsSchema({}), { acknowledgedVersion: 0 });
  for (const value of [-1, 0.5, '1']) assert.throws(() => OnboardingSettingsSchema({ acknowledgedVersion: value }));
  for (const value of [undefined, null, {}, { acknowledgedVersion: -1 }, { acknowledgedVersion: 0.5 }, { acknowledgedVersion: '1' }, { acknowledgedVersion: Infinity }]) {
    assert.equal(decodeOnboarding(value), undefined);
  }
  assert.deepEqual(decodeOnboarding({ acknowledgedVersion: 8 }), { acknowledgedVersion: 8 });
});
