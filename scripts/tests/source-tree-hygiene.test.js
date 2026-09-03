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

  it('does not expose retired Otto release entry points', () => {
    const retiredReleaseFiles = [
      '.github/workflows/release.yml',
      '.github/workflows/deploy-server.yml',
      'docs/github-actions-release.md',
      'docs/lstc-1.9.5-push-bundle.md',
      'docs/lstc-1.9.5-runbook.md',
      'docs/release-preflight.md',
      'docs/repository-migration.md',
      'docs/RELEASE.md',
    ];

    expect(
      retiredReleaseFiles.filter((relativePath) =>
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

  it('keeps the npm lockfile on the official registry', () => {
    const lockfile = readFileSync(
      path.join(rootDir, 'package-lock.json'),
      'utf8',
    );

    expect(lockfile).not.toMatch(
      /registry\.npmmirror\.com|registry\.npm\.taobao\.org|registry\.cnpmjs\.org/u,
    );
  });

  it('keeps builds lockfile-only and sandbox detection self-contained', () => {
    const buildScript = readFileSync(
      path.join(rootDir, 'scripts/build.js'),
      'utf8',
    );
    const sandboxScript = readFileSync(
      path.join(rootDir, 'scripts/sandbox_command.js'),
      'utf8',
    );

    expect(buildScript).not.toContain("execSync('npm install'");
    expect(buildScript).toContain('Run npm ci first');
    expect(sandboxScript).not.toContain("from 'dotenv'");
    expect(sandboxScript).toContain('process.loadEnvFile(');
  });

  it('runs E2EE checks through the current desktop workspace', () => {
    const runner = readFileSync(
      path.join(rootDir, 'scripts/run-e2ee-adversarial-verification.mjs'),
      'utf8',
    );

    expect(runner).toContain("'packages/desktop'");
    expect(runner).not.toContain("'otto-desktop'");
  });

  it('tracks renderer asset types in clean checkouts', () => {
    const ignoreRules = readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
    const assetTypes = readFileSync(
      path.join(rootDir, 'packages/desktop/src/renderer/css.d.ts'),
      'utf8',
    );

    expect(ignoreRules).toContain('!packages/desktop/src/renderer/css.d.ts');
    expect(assetTypes).toContain("declare module '*.png'");
    expect(assetTypes).toContain("declare module '*.svg'");
  });

  it('pins patched production transitive dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    );

    expect(manifest.overrides['@xmldom/xmldom']).toBe('^0.8.15');
    expect(manifest.overrides['fast-uri@^3.0.0']).toBe('^3.1.6');
    expect(manifest.overrides.qs).toBe('^6.16.0');
  });
});
