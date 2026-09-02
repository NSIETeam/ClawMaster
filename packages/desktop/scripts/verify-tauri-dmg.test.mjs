import { describe, expect, it } from 'vitest';
import {
  assertApplicationsLink,
  resolveSingleTauriDmg,
} from './verify-tauri-dmg.mjs';

describe('Tauri DMG verification', () => {
  it('requires exactly one final artifact', () => {
    expect(resolveSingleTauriDmg(['/release/ClawMaster.dmg']))
      .toBe('/release/ClawMaster.dmg');
    expect(() => resolveSingleTauriDmg([])).toThrow('exactly one');
    expect(() => resolveSingleTauriDmg(['/a.dmg', '/b.dmg'])).toThrow('found 2');
  });

  it('requires the canonical Applications symlink', () => {
    expect(() =>
      assertApplicationsLink('/mounted/Applications', {
        metadata: () => ({ isSymbolicLink: () => true }),
        readLink: () => '/Applications',
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicationsLink('/mounted/Applications', {
        metadata: () => ({ isSymbolicLink: () => false }),
        readLink: () => '/Applications',
      }),
    ).toThrow('Applications link');
  });
});
