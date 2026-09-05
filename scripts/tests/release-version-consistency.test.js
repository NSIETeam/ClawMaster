/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(path.resolve('package.json'), 'utf8'),
);
const version = packageJson.version;

const versionDisplays = [
  {
    path: 'packages/desktop/src/renderer/browserPreviewBridge.ts',
    expected: [
      `Promise.resolve('${version}-browser-preview')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/server/src/server.ts',
    expected: [
      `appVersion: () => Promise.resolve('${version}')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/server/src/enterprise/bin.ts',
    expected: [`CLAWMASTER_APP_VERSION=${version}`],
  },
];

describe('release version displays', () => {
  it.each(versionDisplays)(
    'keeps $path aligned with package.json',
    ({ path: sourcePath, expected }) => {
      const source = readFileSync(path.resolve(sourcePath), 'utf8');

      for (const literal of expected) {
        expect(source, `${sourcePath} is missing ${literal}`).toContain(
          literal,
        );
      }
    },
  );

  it('uses locked installs and validates the current Tauri release source', () => {
    const workflow = readFileSync(
      path.resolve('.github/workflows/tauri-preview.yml'),
      'utf8',
    );

    expect(workflow).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(workflow).toContain("branches: [main, 'codex/windows-*']");
    expect(workflow).toContain('test "$GITHUB_REF_NAME" = "v${version}"');
    expect(workflow).toContain('npm run validate:integration-baseline');
    expect(workflow).toMatch(/Install locked dependencies\n\s+run: npm ci/g);
    expect(workflow).not.toMatch(/run: npm install(?:\s|$)/g);
    expect(workflow).toContain("-name '*.msi'");
    expect(workflow).toContain('"$(basename "$file")"');

    const ciWorkflow = readFileSync(
      path.resolve('.github/workflows/ci.yml'),
      'utf8',
    );
    expect(ciWorkflow).toMatch(/Install locked dependencies\n\s+run: npm ci/);
    expect(ciWorkflow).not.toMatch(/run: npm install(?:\s|$)/g);
  });
});
