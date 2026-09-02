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
  it('keeps the animated pet atlas as a compact indexed PNG', () => {
    const atlas = path.join(assetsRoot, 'otto-pet-atlas.png');

    expect(statSync(atlas).size).toBeLessThan(300 * 1024);
    expect(readPngMetadata(atlas)).toEqual({
      width: 768,
      height: 936,
      bitDepth: 8,
      colorType: 3,
    });
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

  it('keeps the shared avatar compact at its rendered resolution', () => {
    const avatar = path.join(assetsRoot, 'otto-avatar.png');

    expect(statSync(avatar).size).toBeLessThan(50 * 1024);
    expect(readPngMetadata(avatar)).toEqual({
      width: 256,
      height: 256,
      bitDepth: 8,
      colorType: 3,
    });
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

  it('keeps the meeting-room thumbnail optimized for its card-sized rendering', () => {
    const optimized = path.join(assetsRoot, 'meeting-room-default.jpg');
    const legacy = path.join(assetsRoot, 'meeting-room-default.png');
    const component = readFileSync(
      path.join(desktopRoot, 'src', 'renderer', 'components', 'ParkServicesPlugin.tsx'),
      'utf8',
    );

    expect(existsSync(optimized)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(statSync(optimized).size).toBeLessThan(80 * 1024);
    expect(component).toContain("../assets/meeting-room-default.jpg");
  });

  it('does not retain the unreferenced legacy avatar source set', () => {
    expect(existsSync(path.join(desktopRoot, 'build', 'avatar'))).toBe(false);
    const releaseGate = readFileSync(
      path.join(desktopRoot, 'scripts', 'release-recovery-gate.mjs'),
      'utf8',
    );
    expect(releaseGate).toContain("'src', 'renderer', 'assets', 'otto-avatar.png'");
    expect(releaseGate).not.toContain("'otto-avatar-1.png'");
  });
});
