#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPENDENCY_INSPECTION_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function requireArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? null : process.argv[index + 1]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function resolveWindowsDependencyInspector({
  environment = process.env,
  fileExists = existsSync,
} = {}) {
  const candidates = [
    environment.RUNNER_TEMP
      ? path.join(environment.RUNNER_TEMP, 'msys64', 'ucrt64', 'bin', 'objdump.exe')
      : null,
    path.join(environment.SystemDrive ?? 'C:', 'msys64', 'ucrt64', 'bin', 'objdump.exe'),
  ].filter(Boolean);
  const objdump = candidates.find((candidate) => fileExists(candidate));
  return objdump
    ? { command: objdump, arguments: ['-p'] }
    : { command: 'dumpbin', arguments: ['/dependents'] };
}

function inspectLinkedLibraries(binding, target) {
  if (target.startsWith('darwin-')) {
    return execFileSync('otool', ['-L', binding], { encoding: 'utf8' });
  }
  const inspector = resolveWindowsDependencyInspector();
  return execFileSync(
    inspector.command,
    [...inspector.arguments, binding],
    {
      encoding: 'utf8',
      maxBuffer: DEPENDENCY_INSPECTION_MAX_BUFFER_BYTES,
    },
  );
}

export function verifyTauriSqlCipherAsset({
  assetDirectory,
  expectedTarget,
  expectedNodeVersion,
  expectedModuleAbi,
  dependencyOutput,
}) {
  const binding = path.join(assetDirectory, 'better_sqlite3.node');
  const manifestPath = path.join(assetDirectory, 'manifest.json');
  const required = [binding, manifestPath];
  if (required.some((file) => !existsSync(file))) {
    throw new Error(`incomplete Tauri SQLCipher asset: ${assetDirectory}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expectedCryptoProvider = expectedTarget.startsWith('darwin-')
    ? 'commoncrypto'
    : expectedTarget === 'win32-x64'
      ? 'openssl-static'
      : null;
  if (!expectedCryptoProvider) {
    throw new Error(`unsupported Tauri SQLCipher target: ${expectedTarget}`);
  }
  const expected = {
    format: 3,
    target: expectedTarget,
    runtime: 'node',
    runtimeVersion: expectedNodeVersion,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) {
      throw new Error(`Tauri SQLCipher manifest ${field} must be ${value}`);
    }
  }
  if (
    manifest.toolchain?.moduleAbi !== expectedModuleAbi
    || manifest.toolchain?.cryptoProvider !== expectedCryptoProvider
  ) {
    throw new Error('Tauri SQLCipher toolchain identity is invalid');
  }
  if (manifest.sha256 !== sha256(binding)) {
    throw new Error('Tauri SQLCipher binding checksum mismatch');
  }

  const notices = path.join(assetDirectory, manifest.notices?.path ?? '');
  const sbomPath = path.join(assetDirectory, manifest.sbom?.path ?? '');
  if (
    !existsSync(notices)
    || manifest.notices?.sha256 !== sha256(notices)
    || !existsSync(sbomPath)
    || manifest.sbom?.sha256 !== sha256(sbomPath)
  ) {
    throw new Error('Tauri SQLCipher notices or SBOM checksum mismatch');
  }

  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  const components = sbom.components ?? [];
  const properties = new Map(
    (sbom.metadata?.properties ?? []).map((entry) => [entry.name, entry.value]),
  );
  if (
    sbom.bomFormat !== 'CycloneDX'
    || !components.some((entry) => entry.name === 'SQLCipher')
    || !components.some((entry) => entry.name === 'better-sqlite3')
    || properties.get('otto:runtime') !== 'node'
    || properties.get('otto:runtimeVersion') !== expectedNodeVersion
    || properties.get('otto:moduleAbi') !== expectedModuleAbi
    || properties.get('otto:cryptoProvider') !== expectedCryptoProvider
  ) {
    throw new Error('Tauri SQLCipher SBOM identity is invalid');
  }

  const linkedLibraries = dependencyOutput
    ?? inspectLinkedLibraries(binding, expectedTarget);
  if (/\s(?:\/opt\/|\/usr\/local\/|\/Users\/)/u.test(linkedLibraries)) {
    throw new Error('Tauri SQLCipher binding contains a machine-local dynamic dependency');
  }
  if (expectedCryptoProvider === 'openssl-static' && /lib(?:crypto|ssl)/iu.test(linkedLibraries)) {
    throw new Error('Tauri SQLCipher Windows binding must link OpenSSL statically');
  }

  return { binding, manifest };
}

function main() {
  const result = verifyTauriSqlCipherAsset({
    assetDirectory: path.resolve(requireArgument('--asset-directory')),
    expectedTarget: requireArgument('--target'),
    expectedNodeVersion: requireArgument('--node-version'),
    expectedModuleAbi: requireArgument('--module-abi'),
  });
  process.stdout.write(
    `[tauri-sqlcipher] verified ${result.manifest.target} `
    + `${result.manifest.runtime} ${result.manifest.runtimeVersion}\n`,
  );
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
