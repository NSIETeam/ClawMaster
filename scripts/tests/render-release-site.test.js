/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { buildReleaseManifest } from '../render-release-site.mjs';

const files = [
  { name: 'ClawMaster_0.0.2-3_x64-setup.exe', size: 4_000_000 },
  { name: 'ClawMaster_0.0.2-3_x64_en-US.msi', size: 5_000_000 },
  { name: 'ClawMaster_0.0.2-beta.3_aarch64.dmg', size: 6_000_000 },
];
const checksumSource = files
  .map((file, index) => `${String(index + 1).repeat(64)}  ${file.name}`)
  .join('\n');

describe('release site manifest', () => {
  it('publishes only the Windows x64 and macOS ARM64 matrix', () => {
    const manifest = buildReleaseManifest({
      tagName: 'v0.0.2-beta.3',
      files,
      checksumSource,
    });

    expect(manifest.version).toBe('0.0.2-beta.3');
    expect(Object.keys(manifest.assets)).toEqual(['windows', 'windowsMsi', 'mac']);
    expect(manifest.assets.windows.url).toContain('ClawMaster_0.0.2-3_x64-setup.exe');
    expect(manifest.assets.mac.size).toBe('5.72 MiB');
  });

  it('refuses an incomplete release or unsafe tag', () => {
    expect(() => buildReleaseManifest({ tagName: 'latest', files, checksumSource })).toThrow('Invalid release tag');
    expect(() => buildReleaseManifest({
      tagName: 'v0.0.2-beta.3',
      files: files.slice(1),
      checksumSource,
    })).toThrow('Windows NSIS');
  });
});
