/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('desktop visual style contract', () => {
  it('keeps the right rail and full-page authentication on the system appearance contract', async () => {
    const [css, tokens] = await Promise.all([
      readFile(path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'), 'utf8'),
      readFile(path.join(packageRoot, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8'),
    ]);

    expect(tokens).toContain('color-scheme: light dark;');
    expect(css).toMatch(/\.claw-right-panel\s*\{[^}]*color-scheme: light dark;/su);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.claw-auth-shell\s*\{/su);
    expect(css).toContain('.claw-auth-panel {\n    background: var(--claw-bg);');
    expect(css).toContain('background: color-mix(in srgb, var(--claw-surface) 94%, transparent);');
  });

  it('does not leave fixed pale status surfaces in desktop subpages', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    for (const fixedLightSurface of ['#fff5f3', '#ecfdf5', '#fff5f5', '#fff1f2']) {
      expect(css).not.toContain(fixedLightSurface);
    }
  });

  it('keeps module groups on the shared appearance tokens', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    expect(css).toMatch(/\.claw-module-group\s*\{[^}]*background: var\(--claw-surface\);/su);
    expect(css).toMatch(/\.claw-module-group__header h2\s*\{[^}]*color: var\(--claw-text\);/su);
    expect(css).toMatch(/\.claw-module-tile\s*\{[^}]*color: var\(--claw-text\);/su);
    expect(css).not.toContain('var(--surface, #fff)');
    expect(css).not.toContain('var(--surface-subtle, #f5f7fa)');
  });

  it('keeps right-rail module names readable instead of squeezing three cards across', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    expect(css).toMatch(/\.claw-module-workspace--panel \.claw-module-group__grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/su);
    expect(css).toMatch(/\.claw-module-workspace--panel \.claw-module-group__grid--rows-4\s*\{[^}]*max-height: 306px;/su);
    expect(css).toMatch(/\.claw-module-tile > span:last-child\s*\{[^}]*overflow-wrap: anywhere;[^}]*word-break: normal;/su);
    expect(css).not.toMatch(/\.claw-module-tile > span:last-child\s*\{[^}]*word-break: break-word;/su);
  });

  it('keeps marketplace controls readable while only the catalog scrolls at minimum height', async () => {
    const [css, tokens] = await Promise.all([
      readFile(path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'), 'utf8'),
      readFile(path.join(packageRoot, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8'),
    ]);

    expect(css).toMatch(/\.claw-module-marketplace__header,\s*\.claw-module-marketplace__footer\s*\{[^}]*flex: 0 0 auto;/su);
    expect(css).toMatch(/\.claw-module-marketplace__body\s*\{[^}]*min-height: 0;[^}]*display: flex;[^}]*overflow-y: hidden;/su);
    expect(css).toMatch(/\.claw-module-marketplace__catalog\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/su);
    expect(css).toMatch(/\.claw-module-marketplace__tabs button,\s*\.claw-module-marketplace__filters button\s*\{[^}]*display: inline-flex;[^}]*min-height: 34px;[^}]*padding: 7px 13px;[^}]*line-height: 1\.2;/su);
    expect(tokens).toMatch(/\.sr-only\s*\{[^}]*position: absolute !important;[^}]*clip: rect\(0, 0, 0, 0\) !important;/su);
  });

  it('builds the fast browser preview with production CSS and one React instance', async () => {
    const config = await readFile(path.join(packageRoot, 'build-preview.cjs'), 'utf8');

    for (const stylesheet of [
      'src/renderer/styles/tokens.css',
      'src/renderer/styles/app.css',
      'src/renderer/styles/module-workspace.css',
    ]) {
      expect(config).toContain(stylesheet);
    }
    expect(config).toContain("fs.writeFileSync(path.join(outdir, 'main.css'), css)");
    expect(config).toContain("require.resolve('react/package.json', { paths: [root] })");
    expect(config).toContain("require.resolve('react-dom/package.json', { paths: [root] })");
  });
});
