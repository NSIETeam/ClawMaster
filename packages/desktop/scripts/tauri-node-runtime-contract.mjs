import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NODE_RUNTIME_SCHEMA_VERSION = 1;
export const NODE_RUNTIME_SOURCE_COMMIT = '71b8b174857e25106d39b61a9e6f30d927da8b01';
export const NODE_RUNTIME_BUILD_FLAGS = Object.freeze([
  '--disable-single-executable-application',
  '--v8-disable-object-print',
  '--without-amaro',
  '--without-corepack',
  '--without-node-options',
  '--without-npm',
  '--with-intl=small-icu',
  '--with-icu-locales=en,zh-CN',
]);
export const WINDOWS_NODE_RUNTIME_BUILD_FLAGS = Object.freeze([
  'release',
  'x64',
  'clang-cl',
  'small-icu',
  'nonpm',
  'no-cctest',
  'no-NODE-OPTIONS',
]);

export function nodeRuntimeBuildProfile(target) {
  if (target === 'win32-x64') {
    return { id: 'node24-windows-small-icu-v1', flags: WINDOWS_NODE_RUNTIME_BUILD_FLAGS };
  }
  if (target === 'darwin-arm64' || target === 'darwin-x64') {
    return { id: 'node24-darwin-small-icu-v1', flags: NODE_RUNTIME_BUILD_FLAGS };
  }
  throw new Error(`unsupported minimal Node target: ${target}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedRuntime(target) {
  const values = {
    'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
    'darwin-x64': { platform: 'darwin', arch: 'x64' },
    'win32-x64': { platform: 'win32', arch: 'x64' },
  };
  const expected = values[target];
  if (!expected) throw new Error(`unsupported minimal Node target: ${target}`);
  return expected;
}

function probeNodeRuntime(binary) {
  const source = String.raw`
const crypto = require('node:crypto');
const https = require('node:https');
const inspector = require('node:inspector');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES (\'ready\')');
const sqlite = database.prepare('SELECT value FROM probe').get().value;
database.close();
const locale = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date('2026-09-01T00:00:00Z'));
const english = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date('2026-09-01T00:00:00Z'));
process.stdout.write(JSON.stringify({
  nodeVersion: process.versions.node,
  moduleAbi: process.versions.modules,
  arch: process.arch,
  platform: process.platform,
  crypto: crypto.createHash('sha256').update('clawmaster').digest('hex'),
  fetch: typeof fetch === 'function',
  https: typeof https.request === 'function',
  inspector: typeof inspector.Session === 'function',
  intl: typeof Intl.DateTimeFormat === 'function' && locale.length > 0 && english.length > 0,
  sqlite,
  runtimeConfig: process.config.variables,
}));`;
  const output = execFileSync(binary, ['--eval', source], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(output);
  if (!result.fetch || !result.https || !result.inspector || !result.intl || result.sqlite !== 'ready') {
    throw new Error('minimal Node runtime is missing a required ClawMaster capability');
  }
  return result;
}

export function buildNodeRuntimeManifest({
  binary,
  target,
  sourceCommit = NODE_RUNTIME_SOURCE_COMMIT,
  buildFlags,
}) {
  const bytes = readFileSync(binary);
  const probe = probeNodeRuntime(binary);
  const expected = expectedRuntime(target);
  const profile = nodeRuntimeBuildProfile(target);
  if (probe.platform !== expected.platform || probe.arch !== expected.arch) {
    throw new Error(
      `minimal Node executable target mismatch: expected ${expected.platform}-${expected.arch}, `
      + `got ${probe.platform}-${probe.arch}`,
    );
  }
  return {
    schemaVersion: NODE_RUNTIME_SCHEMA_VERSION,
    target,
    source: {
      repository: 'https://github.com/nodejs/node',
      commit: sourceCommit,
      version: probe.nodeVersion,
    },
    moduleAbi: probe.moduleAbi,
    arch: probe.arch,
    platform: probe.platform,
    buildProfile: profile.id,
    buildFlags: [...(buildFlags ?? profile.flags)].sort(),
    runtimeConfiguration: {
      sha256: sha256(Buffer.from(JSON.stringify(probe.runtimeConfig))),
      variables: Object.fromEntries([
        'icu_small',
        'v8_enable_i18n_support',
        'node_use_node_options',
        'node_install_npm',
        'node_install_corepack',
        'node_shared',
      ].map((key) => [key, probe.runtimeConfig[key] ?? null])),
    },
    capabilities: {
      crypto: true,
      fetch: true,
      https: true,
      inspector: true,
      intl: true,
      sqlite: true,
    },
    binary: {
      file: target.startsWith('win32-') ? 'node.exe' : 'node',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
}

export function writeNodeRuntimeAsset({ binary, outputDirectory, target }) {
  const manifest = buildNodeRuntimeManifest({ binary, target });
  mkdirSync(outputDirectory, { recursive: true });
  const outputBinary = path.join(outputDirectory, manifest.binary.file);
  copyFileSync(binary, outputBinary);
  writeFileSync(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { manifest, outputBinary };
}

export function verifyNodeRuntimeAsset({
  directory,
  target,
  nodeVersion,
  hardLimitBytes = 100 * 1024 * 1024,
}) {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== NODE_RUNTIME_SCHEMA_VERSION) {
    throw new Error(`unsupported minimal Node manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.target !== target) {
    throw new Error(`minimal Node target mismatch: expected ${target}, got ${manifest.target}`);
  }
  const expected = expectedRuntime(target);
  if (manifest.platform !== expected.platform || manifest.arch !== expected.arch) {
    throw new Error('minimal Node manifest architecture does not match its target');
  }
  if (manifest.source?.commit !== NODE_RUNTIME_SOURCE_COMMIT) {
    throw new Error('minimal Node source commit is not the pinned verified release');
  }
  if (manifest.source?.version !== nodeVersion) {
    throw new Error(`minimal Node version mismatch: expected ${nodeVersion}, got ${manifest.source?.version}`);
  }
  const profile = nodeRuntimeBuildProfile(target);
  if (manifest.buildProfile !== profile.id
      || JSON.stringify(manifest.buildFlags) !== JSON.stringify([...profile.flags].sort())) {
    throw new Error('minimal Node build flags do not match the product contract');
  }
  const binary = path.join(directory, manifest.binary.file);
  const bytes = readFileSync(binary);
  if (bytes.length !== manifest.binary.bytes || sha256(bytes) !== manifest.binary.sha256) {
    throw new Error('minimal Node binary hash or size does not match its manifest');
  }
  const probe = probeNodeRuntime(binary);
  const runtimeConfigurationHash = sha256(Buffer.from(JSON.stringify(probe.runtimeConfig)));
  if (manifest.runtimeConfiguration?.sha256 !== runtimeConfigurationHash) {
    throw new Error('minimal Node runtime configuration does not match its binary');
  }
  if (probe.nodeVersion !== nodeVersion || probe.moduleAbi !== manifest.moduleAbi) {
    throw new Error('minimal Node executable does not match its declared ABI');
  }
  if (statSync(binary).size > hardLimitBytes) {
    throw new Error('minimal Node binary exceeds the 100 MiB product hard limit');
  }
  return { manifest, binary, probe };
}
