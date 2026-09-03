/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageRoot, '../..');
const require = createRequire(import.meta.url);
const afterPack = require('./after-pack.cjs');

describe('desktop packaging contract', () => {
  it('pins one Electron version across packaging and native build workflows', async () => {
    const [rootPackageJson, desktopPackageJson, packageLock, nativeWorkflow] =
      await Promise.all([
        readFile(path.join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
        readFile(path.join(packageRoot, 'package.json'), 'utf8').then(
          JSON.parse,
        ),
        readFile(path.join(repoRoot, 'package-lock.json'), 'utf8').then(
          JSON.parse,
        ),
        readFile(
          path.join(repoRoot, '.github', 'workflows', 'sqlcipher-native.yml'),
          'utf8',
        ),
      ]);
    const electronVersion = rootPackageJson.devDependencies.electron;

    expect(electronVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(desktopPackageJson.devDependencies.electron).toBe(electronVersion);
    expect(desktopPackageJson.build.electronVersion).toBe(electronVersion);
    expect(packageLock.packages['node_modules/electron'].version).toBe(
      electronVersion,
    );
    expect(nativeWorkflow).toContain(`ELECTRON_VERSION: ${electronVersion}`);
  });

  it('declares every root-only release script dependency explicitly', async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(rootPackageJson.devDependencies.ora).toBe('^9.0.0');
  });

  it('builds public runtime dependencies before preparing a fresh Tauri checkout', async () => {
    const prepare = await readFile(
      path.join(packageRoot, 'scripts', 'prepare-tauri-runtime.mjs'),
      'utf8',
    );
    const coreBuild = prepare.indexOf(
      "run('npm', ['run', 'build', '--workspace=otto-core'])",
    );
    const serverBuild = prepare.indexOf(
      "run('npm', ['run', 'build', '--workspace=otto-server'])",
    );
    const agentBundle = prepare.indexOf('prepareAgentBundle();');

    expect(coreBuild).toBeGreaterThanOrEqual(0);
    expect(serverBuild).toBeGreaterThan(coreBuild);
    expect(agentBundle).toBeGreaterThan(serverBuild);
    const worker = await readFile(
      path.join(packageRoot, 'scripts', 'document-worker-entry.mjs'),
      'utf8',
    );
    expect(worker).toContain("from 'otto-core'");
    expect(worker).not.toContain('../../core/src/');
  });

  it('uses a real multi-resolution ICO for Windows packaging', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.win.icon).toBe('build/icon.ico');

    const icon = await readFile(path.join(packageRoot, 'build', 'icon.ico'));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const count = icon.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);
    const sizes = new Set();
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 6 + index * 16;
      const widthByte = icon[entryOffset];
      const heightByte = icon[entryOffset + 1];
      const imageSize = icon.readUInt32LE(entryOffset + 8);
      const imageOffset = icon.readUInt32LE(entryOffset + 12);
      sizes.add(widthByte === 0 ? 256 : widthByte);
      expect(heightByte === 0 ? 256 : heightByte).toBe(
        widthByte === 0 ? 256 : widthByte,
      );
      // rcedit writes this size through a 16-bit Windows resource field. A
      // larger PNG is truncated in the final Otto.exe even though the source
      // ICO itself still opens correctly.
      expect(imageSize).toBeLessThanOrEqual(0xffff);
      expect(imageOffset + imageSize).toBeLessThanOrEqual(icon.length);
    }
    for (const size of [16, 32, 48, 256]) {
      expect(sizes.has(size)).toBe(true);
    }
  });

  it('uses a complete multi-resolution ICNS for macOS packaging', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.mac.icon).toBe('build/icon.icns');

    const icon = await readFile(path.join(packageRoot, 'build', 'icon.icns'));
    expect(icon.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icon.readUInt32BE(4)).toBe(icon.length);

    const chunkTypes = new Set();
    let offset = 8;
    while (offset + 8 <= icon.length) {
      const type = icon.subarray(offset, offset + 4).toString('ascii');
      const length = icon.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      chunkTypes.add(type);
      offset += length;
    }
    expect(offset).toBe(icon.length);
    for (const type of ['ic07', 'ic08', 'ic09', 'ic10']) {
      expect(chunkTypes.has(type)).toBe(true);
    }
  });

  it('keeps the supported browser preview on its current model display name', async () => {
    const browserBridge = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'browserPreviewBridge.ts'),
      'utf8',
    );
    expect(browserBridge).toContain("displayName: 'GPT-5.1'");
    expect(browserBridge).not.toContain("displayName: 'gpt-5.1（本地预览）'");
  });

  it('keeps default installers below the lightweight contract by excluding optional runtimes', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const resources = [
      ...(packageJson.build.mac.extraResources ?? []),
      ...(packageJson.build.win.extraResources ?? []),
    ];
    const bundledInputs = resources.map((resource) => resource.from).join('\n');
    expect(bundledInputs).not.toContain('vendor/runtime');
    expect(bundledInputs).not.toContain('resources/video-editor');
  });

  it('keeps package managers and development tools out of user installers', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const buildFiles = packageJson.build.files.join('\n');
    for (const excludedPattern of [
      '!**/node_modules/@otto/native/target/**',
      '!**/node_modules/@otto/native/src/**',
      '!**/node_modules/@otto/native/Cargo.*',
      '!**/node_modules/@otto/native/tsconfig.json',
      '!**/node_modules/better-sqlite3/deps/**',
      '!**/node_modules/better-sqlite3/prebuilds/**',
      '!**/node_modules/better-sqlite3/src/**',
      '!**/node_modules/better-sqlite3/build/deps/**',
      '!**/node_modules/better-sqlite3/build/Release/obj/**',
      '!**/node_modules/better-sqlite3/build/Release/test_extension.node',
      '!**/node_modules/npm/**',
      '!**/node_modules/corepack/**',
      '!**/node_modules/electron/**',
      '!**/node_modules/electron-builder/**',
      '!**/node_modules/typescript/**',
      '!**/node_modules/webpack/**',
      '!**/node_modules/webpack-cli/**',
      '!**/node_modules/eslint/**',
      '!**/node_modules/vitest/**',
    ]) {
      expect(buildFiles).toContain(excludedPattern);
    }

    const verifier = await readFile(
      path.join(packageRoot, 'scripts', 'verify-packaged-runtime.mjs'),
      'utf8',
    );
    expect(verifier).toContain('assertNoPackageManagerRuntime(');
    expect(verifier).toContain(
      'packaged runtime must not include npm, development tools, or build caches',
    );
    expect(verifier).toContain('@otto\\/native\\/target');
    expect(verifier).toContain('better-sqlite3\\/deps');
  });

  it('does not exclude runtime build/src modules required by ESM dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build.files).not.toContain('!**/node_modules/**/src/**');
  });

  it('uses the current dependency collector and verifies the packaged Windows runtime', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.build).not.toHaveProperty('includeSubNodeModules');
    expect(packageJson.build.publish).toEqual([
      {
        provider: 'generic',
        url: 'https://59.110.154.44:7777/downloads',
      },
    ]);
    expect(packageJson.scripts['dist:win']).toContain(
      'node scripts/verify-packaged-runtime.mjs release/win-unpacked/resources/app.asar --platform win32 --arch x64',
    );
    expect(packageJson.scripts['dist:win']).toContain('--publish never');
  });

  it('keeps default ClawMaster release commands on the Tauri formal path', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.scripts.package).toBe('npm run tauri:build');
    expect(packageJson.scripts.release).toBe('npm run tauri:build');
    expect(packageJson.scripts['release:gate']).toBe(
      'node scripts/formal-tauri-release-gate.mjs',
    );
    expect(packageJson.scripts['release:legacy:electron']).toBe(
      'node scripts/make-delivery-zip.mjs --build',
    );
    expect(packageJson.scripts['release:legacy:gate']).toBe(
      'node scripts/release-recovery-gate.mjs',
    );
  });

  it('keeps update manifest download URLs bound to the no-proxy update mirror', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    const mirrorConfig = await readFile(
      path.join(packageRoot, 'scripts', 'update-mirror-config.mjs'),
      'utf8',
    );
    expect(script).toContain('resolveUpdateAssetBaseUrl()');
    expect(mirrorConfig).toContain('process.env.OTTO_UPDATE_ASSET_BASE_URL');
    expect(mirrorConfig).toContain('https://59.110.154.44:7777/downloads');
    expect(script).not.toContain(
      'github.com/Felix201209/otto-releases/releases/download',
    );
  });

  it('disables electron-builder implicit publishing for tagged release builds', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    expect(script).toMatch(/'--publish',\s*'never'/);
  });

  it('requires an explicit transition flag before disabling macOS signing', async () => {
    const script = await readFile(
      path.join(packageRoot, 'scripts', 'make-delivery-zip.mjs'),
      'utf8',
    );
    expect(script).toContain("process.env.OTTO_ALLOW_UNSIGNED_MAC === '1'");
    expect(script).toContain("'--config.mac.identity=null'");
    expect(script).toContain("'--config.mac.hardenedRuntime=false'");
    expect(script).toContain("'--config.mac.notarize=false'");
    expect(script).toContain("'--config.dmg.sign=false'");
    expect(script).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
  });

  it('uses the shared update manifest verifier in the local release gate', async () => {
    const gate = await readFile(
      path.join(packageRoot, 'scripts', 'release-recovery-gate.mjs'),
      'utf8',
    );
    expect(gate).toContain(
      "import { verifyUpdateManifest } from './verify-update-manifest.mjs'",
    );
    expect(gate).toContain('verifyUpdateManifest({');
    expect(gate).toContain('releaseAssetCandidates.some(existsSync)');
    expect(gate).not.toContain("manifest.assets?.['win-x64']");
    expect(gate).not.toContain('latest.json win-x64 sha256 mismatch');
  });

  it('builds a pinned CommonCrypto SQLCipher asset for the Tauri Node sidecar', async () => {
    const workflow = await readFile(
      path.join(repoRoot, '.github', 'workflows', 'sqlcipher-native.yml'),
      'utf8',
    );
    const serverPackage = JSON.parse(
      await readFile(
        path.join(repoRoot, 'packages', 'server', 'package.json'),
        'utf8',
      ),
    );
    expect(serverPackage.dependencies['better-sqlite3']).toBe('13.0.3');
    expect(workflow).toContain('node-version: 24.20.0');
    expect(workflow).toContain(
      'Build Tauri Node SQLCipher addon with Apple CommonCrypto',
    );
    expect(workflow).toContain('-DSQLCIPHER_CRYPTO_CC');
    expect(workflow).toContain('--runtime node');
    expect(workflow).toContain('--crypto-provider commoncrypto');
    expect(workflow).toContain('verify-tauri-sqlcipher-asset.mjs');
    expect(
      workflow.match(/if: github\.event\.repository\.visibility == 'public'/g),
    ).toHaveLength(2);
    expect(workflow).toContain('name: tauri-sqlcipher-${{ matrix.target }}');
    expect(workflow).toContain(
      'Build Tauri Node SQLCipher addon with static Windows OpenSSL',
    );
    expect(workflow).toContain('--crypto-provider openssl-static');
    expect(workflow).toContain('--fetch-retries=5');
    expect(workflow).toContain('--fetch-retry-maxtimeout=120000');
    expect(workflow).toContain(
      'name: Restore static Windows OpenSSL toolchain cache',
    );
    expect(workflow).toContain('path: C:/vcpkg/installed/x64-windows-static');
    expect(workflow).toContain('steps.windows-openssl-cache.outputs.cache-hit');
    expect(
      workflow.match(
        /npm run build-release --prefix node_modules\/better-sqlite3/g,
      ),
    ).toHaveLength(4);
    expect(workflow).not.toContain('npm rebuild better-sqlite3');
  });

  it('provides a reproducible Windows x64 Tauri release workflow', async () => {
    const workflow = await readFile(
      path.join(repoRoot, '.github', 'workflows', 'tauri-preview.yml'),
      'utf8',
    );
    expect(workflow).not.toContain('runner: macos-15');
    expect(workflow).not.toContain('runner: macos-15-intel');
    expect(workflow).toContain('runs-on: windows-2022');
    expect(workflow).toContain('windows_only: true');
    expect(workflow).toContain('node-version: 24.20.0');
    expect(workflow).toContain(
      'npm run tauri:build --workspace=packages/desktop',
    );
    expect(
      workflow.match(
        /npm run release:formal:gate --workspace=packages\/desktop/g,
      ),
    ).toHaveLength(1);
    expect(workflow).toContain('name: Tauri Release Build');
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-runtime.test.ts',
    );
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-candidate-supervisor.test.ts',
    );
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-task-coordinator.test.ts',
    );
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-version-registry.test.ts',
    );
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-controller.test.ts',
    );
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-ipc.test.ts',
    );
    expect(workflow).toContain(
      'packages/desktop/src/main/self-modification-infrastructure.test.ts',
    );
    expect(workflow).toContain('name: ClawMaster-Windows-x64-Tauri-Release');
    expect(workflow).toContain("tags:\n      - 'v*.*.*'");
    expect(workflow).toContain('name: Publish ClawMaster Tauri release');
    expect(workflow).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(workflow).toContain('test "$GITHUB_REF_NAME" = "v${version}"');
    expect(workflow).toContain('Tag mismatch: tag=$tag package=v${version}');
    expect(workflow).toContain(
      "if: startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.publish_release == true)",
    );
    expect(workflow).toContain('pattern: ClawMaster-*-Tauri-Release');
    expect(workflow).toContain(
      'name: ClawMaster v${{ steps.release.outputs.version }}',
    );
    expect(workflow).toContain(
      "draft: ${{ github.event_name == 'workflow_dispatch' && inputs.draft != false }}",
    );
    expect(workflow).toContain(
      "prerelease: ${{ github.event_name == 'workflow_dispatch' && inputs.prerelease == true }}",
    );
    expect(workflow).toContain('name: Install and smoke-test Windows release');
    expect(workflow).toContain('scripts/smoke-tauri-windows-install.ps1');
    expect(workflow).toContain(
      'uses: ./.github/workflows/tauri-node-runtime.yml',
    );
    expect(workflow).toContain('name: tauri-node-win32-x64');
    const nodeWorkflow = await readFile(
      path.join(repoRoot, '.github', 'workflows', 'tauri-node-runtime.yml'),
      'utf8',
    );
    expect(nodeWorkflow).toContain('node-v24.20.0-win-x64.zip');
    expect(nodeWorkflow).toContain(
      '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
    );
    expect(nodeWorkflow).not.toContain('--without-inspector');
    expect(nodeWorkflow).not.toContain('--without-intl');
    expect(nodeWorkflow).not.toContain('--without-sqlite');
    expect(nodeWorkflow).not.toContain('--v8-lite-mode');
    expect(nodeWorkflow).toContain('--enable-lto');
    expect(nodeWorkflow).not.toContain('vcbuild.bat');
    expect(nodeWorkflow).toContain('verify-tauri-node-runtime.mjs');
  });

  it('discovers every packaged LibreOffice bundle before signing Otto', async () => {
    const appPath = await mkdtemp(path.join(os.tmpdir(), 'otto-after-pack-'));
    try {
      const arm64Bundle = path.join(
        appPath,
        'Contents',
        'Resources',
        'runtime',
        'darwin-arm64',
        'libreoffice',
        'LibreOffice.app',
      );
      const x64Bundle = path.join(
        appPath,
        'Contents',
        'Resources',
        'runtime',
        'darwin-x64',
        'libreoffice',
        'LibreOffice.app',
      );
      await Promise.all([
        mkdir(arm64Bundle, { recursive: true }),
        mkdir(x64Bundle, { recursive: true }),
      ]);

      expect(afterPack.findNestedLibreOfficeBundles(appPath)).toEqual([
        arm64Bundle,
        x64Bundle,
      ]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });
});
