import { describe, expect, it } from 'vitest';
import { assertMacBundleIdentity } from './tauri-bundle-identity.mjs';

const expected = { identifier: 'team.nsi.clawmaster.desktop', version: '0.0.2-beta.3' };
const info = {
  CFBundleIdentifier: expected.identifier,
  CFBundleShortVersionString: expected.version,
  CFBundleVersion: expected.version,
  CFBundleExecutable: 'clawmaster-desktop',
};

describe('macOS candidate identity', () => {
  it('accepts the expected candidate', () => {
    expect(() => assertMacBundleIdentity(info, expected)).not.toThrow();
  });
  it.each([
    ['CFBundleShortVersionString', '0.0.2-beta.1'],
    ['CFBundleVersion', '0.0.2-beta.1'],
    ['CFBundleIdentifier', 'ai.otto.desktop'],
    ['CFBundleExecutable', 'Electron'],
  ])('rejects mismatched %s even if the binary is signed', (field, value) => {
    expect(() => assertMacBundleIdentity({ ...info, [field]: value }, expected)).toThrow(field);
  });
  it('rejects missing expected version', () => {
    expect(() => assertMacBundleIdentity(info, { identifier: expected.identifier })).toThrow();
  });
});
