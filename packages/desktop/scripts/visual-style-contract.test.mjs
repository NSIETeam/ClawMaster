/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
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
    expect(css).toMatch(/\.otto-right-panel\s*\{[^}]*color-scheme: light dark;/su);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.otto-auth-shell\s*\{/su);
    expect(css).toContain('.otto-auth-panel {\n    background: var(--otto-bg);');
    expect(css).toContain('background: color-mix(in srgb, var(--otto-surface) 94%, transparent);');
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

  it('keeps both browser previews on the desktop React instance for visual audits', async () => {
    const configs = await Promise.all(
      ['webpack.preview.cjs', 'webpack.live.cjs'].map((file) =>
        readFile(path.join(packageRoot, file), 'utf8')),
    );

    for (const config of configs) {
      expect(config).toContain("'react$': require.resolve('react', { paths: [__dirname] })");
      expect(config).toContain("'react-dom$': require.resolve('react-dom', { paths: [__dirname] })");
    }
  });
});
