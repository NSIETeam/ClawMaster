import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const OPEN_TELEMETRY_SHARED_PACKAGES = Object.freeze([
  '@opentelemetry/core',
  '@opentelemetry/semantic-conventions',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/api-logs',
]);

function installedVersions(packageLock, packageName) {
  const suffix = `node_modules/${packageName}`;
  return new Set(
    Object.entries(packageLock.packages ?? {})
      .filter(([location, descriptor]) =>
        location.endsWith(suffix) && typeof descriptor?.version === 'string',
      )
      .map(([, descriptor]) => descriptor.version),
  );
}

export function createOpenTelemetryBundleAliasArgs({
  packageLock,
  resolvePackageRoot,
}) {
  return OPEN_TELEMETRY_SHARED_PACKAGES.map((packageName) => {
    const versions = [...installedVersions(packageLock, packageName)].sort();
    if (versions.length !== 1) {
      throw new Error(
        `${packageName} bundle deduplication requires one installed version; found ${versions.join(', ') || 'none'}`,
      );
    }
    return `--alias:${packageName}=${resolvePackageRoot(packageName)}`;
  });
}

export function resolveInstalledPackageRoot(packageName, fromManifest) {
  const localRequire = createRequire(fromManifest);
  let current = path.dirname(localRequire.resolve(packageName));
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, 'package.json');
    if (existsSync(manifest)) {
      const descriptor = JSON.parse(readFileSync(manifest, 'utf8'));
      if (descriptor.name === packageName) return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`unable to resolve package root for ${packageName}`);
}
