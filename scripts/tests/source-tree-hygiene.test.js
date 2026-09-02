/**
 * @license Copyright 2026 NSIETeam SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve('.');

describe('source tree hygiene', () => {
  it('does not keep generated JavaScript beside the authoritative TypeScript source', () => {
    const generatedArtifacts = [
      'otto-native/src/index.js',
      'otto-native/src/test.js',
      'otto-native/src/test.ts',
      'scripts/tests/test-setup.d.ts',
      'scripts/tests/test-setup.js',
      'scripts/tests/test-setup.js.map',
      'scripts/tests/vitest.config.d.ts',
      'scripts/tests/vitest.config.js',
      'scripts/tests/vitest.config.js.map',
    ];

    expect(
      generatedArtifacts.filter((relativePath) =>
        existsSync(path.join(rootDir, relativePath)),
      ),
    ).toEqual([]);
  });

  it('runs the native package tests from their maintained Rust source', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, 'otto-native/package.json'), 'utf8'),
    );

    expect(manifest.scripts.test).toBe('cargo test --bin otto-native');
  });

  it('does not retain unreferenced legacy root dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    );
    const retiredDependencies = [
      '@langchain/core',
      '@langchain/langgraph',
      '@larksuiteoapi/node-sdk',
      'fs-extra',
      'gradient-string',
      'mem0ai',
      'open',
      'pidtree',
      'pidusage',
      'pptxgenjs',
      'undici',
    ];

    expect(
      retiredDependencies.filter((name) => name in manifest.dependencies),
    ).toEqual([]);
    expect(manifest.devDependencies).not.toHaveProperty('@types/pidusage');
  });
});
