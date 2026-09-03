#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveTauriRuntimePlatform } from './tauri-runtime-policy.mjs';
import { evaluateAgentBundleLayout } from './agent-bundle-layout.mjs';
import { readVerifiedBinaryCapsule } from './binary-capsule.mjs';
import {
  materializeDirectoryCapsule,
  readVerifiedDirectoryCapsule,
} from './directory-capsule.mjs';
import { assertNoTauriRuntimePackageManagers } from './tauri-runtime-forbidden.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const runtimePlatform = resolveTauriRuntimePlatform(process.platform, process.arch);
const bundle = path.resolve(process.argv[2] ?? path.join(
  desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'ClawMaster.app',
));
const contents = path.join(bundle, 'Contents');
const resources = process.platform === 'win32'
  ? path.join(bundle, 'runtime')
  : path.join(contents, 'Resources', 'runtime');
const nodeCapsule = path.join(resources, 'node', 'node.br');
const nodeManifestPath = path.join(resources, 'node', 'node-manifest.json');
const required = [
  nodeCapsule,
  nodeManifestPath,
  path.join(resources, 'agent', 'bootstrap.mjs'),
  path.join(resources, 'agent', 'directory-capsule.mjs'),
  path.join(resources, 'agent', 'agent.br'),
  path.join(resources, 'agent', 'agent-manifest.json'),
  path.join(resources, 'agent', 'agent-bundle-meta.json'),
  path.join(resources, 'sqlcipher', 'better_sqlite3.node'),
  path.join(resources, 'sqlcipher', 'manifest.json'),
];
const missing = required.filter((candidate) => !existsSync(candidate));
if (missing.length) throw new Error(`Tauri bundle is an incomplete shell; missing:\n${missing.join('\n')}`);

function listPackagedRuntimePaths(root) {
  const paths = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(relative);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
    }
  };
  visit(root);
  return paths;
}

const manifest = JSON.parse(readFileSync(required.at(-1), 'utf8'));
if (manifest.target !== runtimePlatform.target) {
  throw new Error(`wrong SQLCipher target: ${manifest.target}`);
}
if (manifest.runtime !== 'node') throw new Error(`wrong SQLCipher runtime: ${manifest.runtime}`);
const { manifest: agentManifest } = readVerifiedDirectoryCapsule({
  capsulePath: path.join(resources, 'agent', 'agent.br'),
  manifestPath: path.join(resources, 'agent', 'agent-manifest.json'),
  target: runtimePlatform.target,
});
assertNoTauriRuntimePackageManagers(listPackagedRuntimePaths(resources), {
  label: 'Tauri runtime resources',
});
assertNoTauriRuntimePackageManagers(agentManifest.files.map((entry) => entry.path), {
  label: 'Tauri Agent capsule',
});
evaluateAgentBundleLayout(
  agentManifest,
  JSON.parse(readFileSync(path.join(resources, 'agent', 'agent-bundle-meta.json'), 'utf8')),
);
const { bytes: nodeExecutable } = readVerifiedBinaryCapsule({
  capsulePath: nodeCapsule,
  manifestPath: nodeManifestPath,
  target: runtimePlatform.target,
  minimumBytes: 1_000_000,
});
const probeRoot = mkdtempSync(path.join(tmpdir(), 'clawmaster-node-probe-'));
const sidecar = path.join(probeRoot, `node${runtimePlatform.executableSuffix}`);
try {
  const agentRoot = materializeDirectoryCapsule({
    capsulePath: path.join(resources, 'agent', 'agent.br'),
    manifestPath: path.join(resources, 'agent', 'agent-manifest.json'),
    target: runtimePlatform.target,
    targetDirectory: path.join(probeRoot, 'agent'),
  });
  writeFileSync(sidecar, nodeExecutable);
  chmodSync(sidecar, 0o700);
  execFileSync(sidecar, [
    path.join(desktopRoot, 'scripts', 'probe-packaged-sqlcipher.mjs'),
    '--binding', path.join(resources, 'sqlcipher', 'better_sqlite3.node'),
    '--module-root', agentRoot,
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const documentSource = path.join(probeRoot, 'document-smoke.md');
  const documentOutput = path.join(probeRoot, 'document-smoke-edited.md');
  writeFileSync(documentSource, '# ClawMaster document smoke\n');
  const runDocumentWorker = (request) => {
    const output = execFileSync(sidecar, [
      path.join(resources, 'agent', 'bootstrap.mjs'),
      'document',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify(request),
      env: { ...process.env, OTTO_USER_DIR: path.join(probeRoot, 'document-user') },
    });
    const response = JSON.parse(output);
    if (response.ok !== true) throw new Error(response.error ?? 'document worker smoke failed');
    return response.result;
  };
  const extracted = runDocumentWorker({ operation: 'extract', filePath: documentSource });
  if (!String(extracted.content).includes('ClawMaster document smoke')) {
    throw new Error('document worker extract smoke returned the wrong content');
  }
  runDocumentWorker({
    operation: 'export',
    sourcePath: documentSource,
    content: '# ClawMaster document smoke passed\n',
    outPath: documentOutput,
  });
  if (!readFileSync(documentOutput, 'utf8').includes('smoke passed')) {
    throw new Error('document worker export smoke did not persist the edit');
  }
} finally {
  rmSync(probeRoot, { recursive: true, force: true });
}
console.log(`[tauri-bundle] complete Agent runtime verified: ${bundle}`);
