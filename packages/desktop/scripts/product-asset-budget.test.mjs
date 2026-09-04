import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(desktopRoot, 'src', 'renderer', 'assets');

function readPngMetadata(file) {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
  };
}

describe('product asset budget', () => {
  it('keeps the retired animated pet atlas out of the lean renderer', () => {
    const atlas = path.join(assetsRoot, 'otto-pet-atlas.png');
    const component = readFileSync(
      path.join(desktopRoot, 'src', 'renderer', 'components', 'ClawMasterPetStage.tsx'),
      'utf8',
    );

    expect(existsSync(atlas)).toBe(false);
    expect(component).not.toContain("../assets/otto-pet-atlas.png");
    expect(component).toContain('claw-pet-stage__mark');
  });

  it('keeps the generated icon catalog compact without duplicate source assets', () => {
    const iconRoot = path.join(assetsRoot, 'generated-icons');
    const icons = readdirSync(iconRoot)
      .filter((file) => file.endsWith('.png'))
      .map((file) => path.join(iconRoot, file));
    const totalBytes = icons.reduce((total, file) => total + statSync(file).size, 0);

    expect(icons).toHaveLength(47);
    expect(totalBytes).toBeLessThan(400 * 1024);
    for (const icon of icons) {
      expect(statSync(icon).size).toBeLessThan(12 * 1024);
      expect(readPngMetadata(icon)).toEqual({
        width: 128,
        height: 128,
        bitDepth: 8,
        colorType: 3,
      });
    }
  });

  it('keeps the shared avatar vector-only in the lean renderer', () => {
    expect(existsSync(path.join(assetsRoot, 'otto-avatar.png'))).toBe(false);
    const icons = readFileSync(
      path.join(desktopRoot, 'src', 'renderer', 'components', 'icons.tsx'),
      'utf8',
    );
    expect(icons).toContain('ClawMasterAvatar');
  });

  it('keeps the product crown compact while preserving Tauri RGBA input', () => {
    const crown = path.join(desktopRoot, 'build', 'icon.png');

    expect(statSync(crown).size).toBeLessThan(20 * 1024);
    expect(readPngMetadata(crown)).toEqual({
      width: 512,
      height: 512,
      bitDepth: 8,
      colorType: 6,
    });
  });

  it('keeps retired meeting-room fallback images out of the lean renderer', () => {
    const retired = path.join(assetsRoot, 'meeting-room-default.jpg');
    const legacy = path.join(assetsRoot, 'meeting-room-default.png');
    const component = readFileSync(
      path.join(desktopRoot, 'src', 'renderer', 'components', 'ParkServicesPlugin.tsx'),
      'utf8',
    );

    expect(existsSync(retired)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(component).not.toContain("../assets/meeting-room-default.jpg");
    expect(component).toContain('claw-park-meeting-room-detail__placeholder');
  });

  it('does not retain the unreferenced legacy avatar source set', () => {
    expect(existsSync(path.join(desktopRoot, 'build', 'avatar'))).toBe(false);
    const releaseGate = readFileSync(
      path.join(desktopRoot, 'scripts', 'release-recovery-gate.mjs'),
      'utf8',
    );
    expect(releaseGate).not.toContain('otto-avatar.png');
    expect(releaseGate).not.toContain("'otto-avatar-1.png'");
  });
});
