#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTauriNodeVersion,
  summarizeRuntimeComponents,
  resolveSqlCipherSource,
  resolveTauriNodeSource,
  resolveTauriRuntimePlatform,
} from './tauri-runtime-policy.mjs';
import {
  readVerifiedBinaryCapsule,
  writeBinaryCapsule,
} from './binary-capsule.mjs';
import {
  materializeDirectoryCapsule,
  readVerifiedDirectoryCapsule,
  writeDirectoryCapsule,
} from './directory-capsule.mjs';
import { evaluateAgentBundleLayout } from './agent-bundle-layout.mjs';
import {
  createOpenTelemetryBundleAliasArgs,
  resolveInstalledPackageRoot,
} from './opentelemetry-bundle-aliases.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const tauriRoot = path.join(desktopRoot, 'src-tauri');
const stagingRoot = path.join(tauriRoot, 'target', 'sidecar-staging');
const runtimeRoot = path.join(stagingRoot, 'runtime');
const agentRoot = path.join(runtimeRoot, 'agent');
const agentPayloadRoot = path.join(stagingRoot, 'agent-payload');
const agentBundleMetafile = path.join(stagingRoot, 'agent-bundle-meta.json');
const nodeCapsuleRoot = path.join(runtimeRoot, 'node');
const binariesRoot = path.join(stagingRoot, 'binaries');
const runtimePlatform = resolveTauriRuntimePlatform(process.platform, process.arch);
const runtimeTarget = runtimePlatform.target;
const nodeSource = resolveTauriNodeSource({
  repoRoot,
  target: runtimeTarget,
  hostBinary: process.execPath,
  pathExists: existsSync,
});
const desktopPackage = JSON.parse(
  readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
);
assertTauriNodeVersion(
  process.versions.node,
  desktopPackage.tauriRuntime.nodeVersion,
);
const sidecarPath = path.join(
  binariesRoot,
  `clawmaster-node-${runtimePlatform.targetTriple}${runtimePlatform.executableSuffix}`,
);
const sqlCipherSource = resolveSqlCipherSource({
  repoRoot,
  target: runtimeTarget,
  pathExists: existsSync,
});
run(process.execPath, [
  path.join(desktopRoot, 'scripts', 'verify-tauri-sqlcipher-asset.mjs'),
  '--asset-directory', sqlCipherSource.path,
  '--target', runtimeTarget,
  '--node-version', desktopPackage.tauriRuntime.nodeVersion,
  '--module-abi', process.versions.modules,
], desktopRoot);

function run(command, args, cwd = repoRoot) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function prepareNodeSidecar() {
  mkdirSync(binariesRoot, { recursive: true });
  rmSync(sidecarPath, { force: true });
  if (nodeSource.manifest) {
    run(process.execPath, [
      path.join(desktopRoot, 'scripts', 'verify-tauri-node-runtime.mjs'),
      '--asset-directory', path.dirname(nodeSource.manifest),
      '--target', runtimeTarget,
      '--node-version', desktopPackage.tauriRuntime.nodeVersion,
    ], desktopRoot);
    cpSync(nodeSource.binary, sidecarPath);
  } else if (runtimePlatform.platform === 'darwin') {
    try {
      run('lipo', [
        nodeSource.binary,
        '-thin', runtimePlatform.binaryArch,
        '-output', sidecarPath,
      ]);
    } catch {
      if (process.arch !== runtimePlatform.arch) throw new Error(
        `Node sidecar architecture mismatch: host=${process.arch}, target=${runtimePlatform.arch}`,
      );
      cpSync(nodeSource.binary, sidecarPath);
    }
    // Keep externally visible symbols required by Node native addons. A full
    // strip makes better-sqlite3/SQLCipher crash with SIGSEGV when dlopen runs.
    run('strip', ['-x', sidecarPath]);
    run('codesign', ['--force', '--sign', '-', sidecarPath]);
  } else {
    cpSync(nodeSource.binary, sidecarPath);
  }
  run(sidecarPath, ['--version']);
  console.log(`[tauri-runtime] Node source: ${nodeSource.provenance}`);
}

function prepareNodeCapsule() {
  rmSync(nodeCapsuleRoot, { recursive: true, force: true });
  const executable = readFileSync(sidecarPath);
  const { manifest } = writeBinaryCapsule({
    bytes: executable,
    directory: nodeCapsuleRoot,
    capsuleName: 'node.br',
    manifestName: 'node-manifest.json',
    target: runtimeTarget,
    metadata: { nodeVersion: desktopPackage.tauriRuntime.nodeVersion },
    quality: 11,
  });
  console.log(
    `[tauri-runtime] Node capsule ${(manifest.compressedBytes / 1024 / 1024).toFixed(1)} MiB `
      + `(source ${(executable.length / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

function prepareAgentBundle() {
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(agentPayloadRoot, { recursive: true, force: true });
  rmSync(agentBundleMetafile, { force: true });
  mkdirSync(path.join(agentPayloadRoot, 'node_modules'), { recursive: true });
  const openTelemetryAliasArgs = createOpenTelemetryBundleAliasArgs({
    packageLock: JSON.parse(
      readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
    ),
    resolvePackageRoot: (packageName) =>
      resolveInstalledPackageRoot(
        packageName,
        path.join(repoRoot, 'packages', 'core', 'package.json'),
      ),
  });
  run(path.join(repoRoot, 'node_modules', '.bin', 'esbuild'), [
    `server=${path.join(repoRoot, 'packages', 'server', 'dist', 'bin.js')}`,
    `document=${path.join(desktopRoot, 'scripts', 'document-worker-entry.mjs')}`,
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    '--minify', '--splitting',
    "--banner:js=import { createRequire as __createRequire } from 'node:module'; const __runtimeBase = process.env.CLAWMASTER_AGENT_ROOT ? process.env.CLAWMASTER_AGENT_ROOT + '/server.mjs' : process.env.CLAWMASTER_RESOURCES_PATH ? process.env.CLAWMASTER_RESOURCES_PATH + '/agent/server.mjs' : import.meta.url; const require = __createRequire(__runtimeBase); if (process.env.CLAWMASTER_RESOURCES_PATH) Object.defineProperty(process, 'resourcesPath', { value: process.env.CLAWMASTER_RESOURCES_PATH });",
    '--external:better-sqlite3', '--external:@otto/native', '--external:pg-native',
    // Heavy document parsers are optional capability modules. Keep the resident
    // desktop agent self-iteration/RPA path small; load PDF/XLSX support through
    // a user-authorized module instead of charging every install for it.
    '--external:pdf-parse', '--external:pdf2json', '--external:xlsx',
    '--external:playwright-core',
    ...openTelemetryAliasArgs,
    '--entry-names=[name]',
    '--chunk-names=chunks/[name]-[hash]',
    '--out-extension:.js=.mjs',
    `--metafile=${agentBundleMetafile}`,
    `--outdir=${agentPayloadRoot}`,
  ]);
  const rawMetafile = JSON.parse(readFileSync(agentBundleMetafile, 'utf8'));
  writeFileSync(agentBundleMetafile, `${JSON.stringify({
    outputs: Object.fromEntries(Object.entries(rawMetafile.outputs).map(([outputPath, output]) => [
      outputPath,
      { bytes: output.bytes, entryPoint: output.entryPoint, imports: output.imports },
    ])),
  })}\n`);
  const sqliteDestination = path.join(agentPayloadRoot, 'node_modules', 'better-sqlite3');
  mkdirSync(sqliteDestination, { recursive: true });
  cpSync(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'lib'), path.join(sqliteDestination, 'lib'), { recursive: true });
  cpSync(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'package.json'), path.join(sqliteDestination, 'package.json'));

  const nativeDestination = path.join(agentPayloadRoot, 'node_modules', '@otto', 'native');
  mkdirSync(path.join(nativeDestination, 'dist'), { recursive: true });
  cpSync(
    path.join(repoRoot, 'otto-native', 'dist', 'index.js'),
    path.join(nativeDestination, 'dist', 'index.js'),
  );
  cpSync(path.join(repoRoot, 'otto-native', 'package.json'), path.join(nativeDestination, 'package.json'));

  // RPA keeps Playwright Core optional in Core, but the productized desktop runtime
  // must make the adapter usable without asking the user to install npm packages.
  // Copy runtime files only (no declarations/docs/tests) so the runtime payload
  // can leave enough headroom for the current 30 MiB download gate while the
  // product continues toward the next 20 MiB slimming target.
  const copyRuntimePackage = (name, files) => {
    const source = path.join(repoRoot, 'node_modules', name);
    if (!existsSync(source)) return;
    const destination = path.join(agentPayloadRoot, 'node_modules', name);
    mkdirSync(destination, { recursive: true });
    for (const entry of files) {
      const from = path.join(source, entry);
      if (existsSync(from)) cpSync(from, path.join(destination, entry), { recursive: true });
    }
  };
  copyRuntimePackage('playwright-core', ['package.json', 'index.js', 'index.mjs', 'browsers.json', 'lib']);
  // The desktop RPA adapter launches an installed browser headlessly. Playwright's
  // trace viewer, recorder, dashboard, and HTML report frontends are developer UI
  // assets and are never loaded on that path.
  rmSync(path.join(agentPayloadRoot, 'node_modules', 'playwright-core', 'lib', 'vite'), {
    recursive: true,
    force: true,
  });
  // CLI dashboards, MCP entrypoints and bundled authoring skills are developer
  // surfaces. ClawMaster invokes the Playwright library API directly, so
  // retaining them in every installed runtime only creates false product paths.
  for (const relative of [
    ['lib', 'entry'],
    ['lib', 'tools'],
    ['lib', 'server', 'electron'],
    ['lib', 'server', 'chromium', 'appIcon.png'],
    ['lib', 'webp_codec.wasm'],
  ]) {
    rmSync(
      path.join(agentPayloadRoot, 'node_modules', 'playwright-core', ...relative),
      { recursive: true, force: true },
    );
  }
  const coreAssets = path.join(agentPayloadRoot, 'core-assets');
  mkdirSync(coreAssets, { recursive: true });
  cpSync(path.join(repoRoot, 'packages', 'core', 'skills-seed'), path.join(coreAssets, 'skills-seed'), { recursive: true });
  cpSync(path.join(repoRoot, 'packages', 'core', 'scripts'), path.join(coreAssets, 'scripts'), { recursive: true });

  mkdirSync(agentRoot, { recursive: true });
  const manifest = writeDirectoryCapsule({
    sourceDirectory: agentPayloadRoot,
    capsulePath: path.join(agentRoot, 'agent.br'),
    manifestPath: path.join(agentRoot, 'agent-manifest.json'),
    target: runtimeTarget,
    quality: 10,
  });
  cpSync(
    path.join(desktopRoot, 'scripts', 'agent-capsule-bootstrap.mjs'),
    path.join(agentRoot, 'bootstrap.mjs'),
  );
  cpSync(
    path.join(desktopRoot, 'scripts', 'directory-capsule.mjs'),
    path.join(agentRoot, 'directory-capsule.mjs'),
  );
  cpSync(
    path.join(desktopRoot, 'scripts', 'sidecar-parent-lifetime.mjs'),
    path.join(agentRoot, 'sidecar-parent-lifetime.mjs'),
  );
  cpSync(agentBundleMetafile, path.join(agentRoot, 'agent-bundle-meta.json'));
  rmSync(agentPayloadRoot, { recursive: true, force: true });
  console.log(
    `[tauri-runtime] Agent capsule ${(manifest.compressedBytes / 1024 / 1024).toFixed(1)} MiB `
      + `(source ${(manifest.uncompressedBytes / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

function prepareNativeResources() {
  cpSync(sqlCipherSource.path, path.join(runtimeRoot, 'sqlcipher'), { recursive: true });
  console.log(`[tauri-runtime] SQLCipher source: ${sqlCipherSource.provenance}`);
}

function verifyStaging() {
  const required = [
    sidecarPath,
    path.join(nodeCapsuleRoot, 'node.br'),
    path.join(nodeCapsuleRoot, 'node-manifest.json'),
    path.join(agentRoot, 'bootstrap.mjs'),
    path.join(agentRoot, 'directory-capsule.mjs'),
    path.join(agentRoot, 'sidecar-parent-lifetime.mjs'),
    path.join(agentRoot, 'agent.br'),
    path.join(agentRoot, 'agent-manifest.json'),
    path.join(agentRoot, 'agent-bundle-meta.json'),
    path.join(runtimeRoot, 'sqlcipher', 'better_sqlite3.node'),
    path.join(runtimeRoot, 'sqlcipher', 'manifest.json'),
  ];
  const missing = required.filter((candidate) => !existsSync(candidate));
  if (missing.length) throw new Error(`incomplete Tauri runtime staging:\n${missing.join('\n')}`);
  const manifest = JSON.parse(readFileSync(required.at(-1), 'utf8'));
  if (manifest.target !== runtimeTarget) {
    throw new Error(`expected ${runtimeTarget} SQLCipher, got ${manifest.target ?? 'unknown'}`);
  }
  readVerifiedBinaryCapsule({
    capsulePath: path.join(nodeCapsuleRoot, 'node.br'),
    manifestPath: path.join(nodeCapsuleRoot, 'node-manifest.json'),
    target: runtimeTarget,
    minimumBytes: 1_000_000,
    expectedMetadata: { nodeVersion: desktopPackage.tauriRuntime.nodeVersion },
  });
  const { manifest: agentManifest } = readVerifiedDirectoryCapsule({
    capsulePath: path.join(agentRoot, 'agent.br'),
    manifestPath: path.join(agentRoot, 'agent-manifest.json'),
    target: runtimeTarget,
  });
  const agentLayout = evaluateAgentBundleLayout(
    agentManifest,
    JSON.parse(readFileSync(path.join(agentRoot, 'agent-bundle-meta.json'), 'utf8')),
  );
  console.log(
    `[tauri-runtime] resident Agent closure ${(agentLayout.residentEntryBytes / 1024 / 1024).toFixed(1)} MiB `
      + `across ${agentLayout.residentFileCount} files; `
      + `${agentLayout.deferredChunkCount} deferred chunks`,
  );
  const directoryBytes = (directory) => readdirSync(directory, { withFileTypes: true })
    .reduce((total, entry) => {
      const candidate = path.join(directory, entry.name);
      return total + (entry.isDirectory() ? directoryBytes(candidate) : statSync(candidate).size);
    }, 0);
  const size = summarizeRuntimeComponents(Object.fromEntries(
    readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name, directoryBytes(path.join(runtimeRoot, entry.name))]),
  ));
  const sizeMiB = (size.bytes / 1024 / 1024).toFixed(1);
  console.log('[tauri-runtime] component budget:');
  for (const component of size.components) {
    console.log(
      `  ${component.name}: ${(component.bytes / 1024 / 1024).toFixed(2)} MiB`,
    );
  }
  if (!size.withinTarget) {
    console.warn(
      `[tauri-runtime] ${sizeMiB} MiB exceeds the 28 MiB runtime target reserved for a 30 MiB download`,
    );
  } else {
    console.log(`[tauri-runtime] ${sizeMiB} MiB is within the 28 MiB runtime target`);
  }
  const probeAgentRoot = path.join(stagingRoot, 'agent-probe');
  try {
    materializeDirectoryCapsule({
      capsulePath: path.join(agentRoot, 'agent.br'),
      manifestPath: path.join(agentRoot, 'agent-manifest.json'),
      target: runtimeTarget,
      targetDirectory: probeAgentRoot,
    });
    run(sidecarPath, [
      path.join(desktopRoot, 'scripts', 'probe-packaged-sqlcipher.mjs'),
      '--binding', path.join(runtimeRoot, 'sqlcipher', 'better_sqlite3.node'),
      '--module-root', probeAgentRoot,
    ], desktopRoot);
  } finally {
    rmSync(probeAgentRoot, { recursive: true, force: true });
  }
  console.log(`[tauri-runtime] minimal Agent runtime staged at ${runtimeRoot}`);
}

run(process.execPath, [npmCli, 'run', 'build', '--workspace=otto-core']);
run(process.execPath, [npmCli, 'run', 'build', '--workspace=otto-server']);
run(process.execPath, [npmCli, 'run', 'build', '--workspace=@otto/native']);
prepareNodeSidecar();
prepareAgentBundle();
prepareNodeCapsule();
prepareNativeResources();
verifyStaging();
// The executable is only an intermediate input for capability/native-addon
// probes and the compressed capsule. Tauri packages the capsule, so retaining
// a second 90+ MiB copy in target/ creates a misleading legacy sidecar path.
rmSync(binariesRoot, { recursive: true, force: true });
