import { describe, expect, it } from 'vitest';

import {
  OPEN_TELEMETRY_SHARED_PACKAGES,
  createOpenTelemetryBundleAliasArgs,
} from './opentelemetry-bundle-aliases.mjs';

function lockWithVersions(versionsByPackage) {
  const packages = {};
  for (const [name, versions] of Object.entries(versionsByPackage)) {
    versions.forEach((version, index) => {
      packages[
        `${index ? `node_modules/dependency-${index}/` : ''}node_modules/${name}`
      ] = { version };
    });
  }
  return { packages };
}

describe('OpenTelemetry Agent bundle aliases', () => {
  it('aliases identical package copies to one canonical root', () => {
    const versions = Object.fromEntries(
      OPEN_TELEMETRY_SHARED_PACKAGES.map((name) => [name, ['1.2.3', '1.2.3']]),
    );
    const args = createOpenTelemetryBundleAliasArgs({
      packageLock: lockWithVersions(versions),
      resolvePackageRoot: (name) => `/canonical/${name}`,
    });

    expect(args).toEqual(
      OPEN_TELEMETRY_SHARED_PACKAGES.map(
        (name) => `--alias:${name}=/canonical/${name}`,
      ),
    );
  });

  it('refuses aliases when installed versions diverge', () => {
    const versions = Object.fromEntries(
      OPEN_TELEMETRY_SHARED_PACKAGES.map((name) => [name, ['1.2.3']]),
    );
    versions['@opentelemetry/core'] = ['1.2.3', '2.0.0'];

    expect(() =>
      createOpenTelemetryBundleAliasArgs({
        packageLock: lockWithVersions(versions),
        resolvePackageRoot: (name) => `/canonical/${name}`,
      }),
    ).toThrow(/@opentelemetry\/core.*1\.2\.3.*2\.0\.0/);
  });
});
