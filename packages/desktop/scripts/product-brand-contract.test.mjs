import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
describe('ClawMaster product identity contract', () => {
  it('keeps the shipped identity and repository metadata aligned', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const desktop = JSON.parse(fs.readFileSync(path.join(root, 'packages/desktop/package.json'), 'utf8'));
    expect(pkg.name).toBe('clawmaster');
    expect(desktop.name).toBe('clawmaster-desktop');
    expect(pkg.repository.url).toContain('NSIETeam/ClawMaster');
  });

  it('does not resurrect the deleted green distribution branch', () => {
    const files = fs.readdirSync(path.join(root, 'packages/desktop/scripts'))
      .filter((name) => name.endsWith('.mjs') && name !== 'product-brand-contract.test.mjs');
    const source = files.map((name) => fs.readFileSync(path.join(root, 'packages/desktop/scripts', name), 'utf8')).join('\n');
    expect(source).not.toMatch(/ClawMaster Green|otto-green|CLAWMASTER_GREEN/u);
  });
});
