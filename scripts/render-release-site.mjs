#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'NSIETeam/ClawMaster';

function parseChecksums(source) {
  return new Map(
    source
      .trim()
      .split('\n')
      .map((line) => line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i))
      .filter(Boolean)
      .map((match) => [match[2], match[1].toLowerCase()]),
  );
}

function selectAsset(files, pattern, label) {
  const matches = files.filter((file) => pattern.test(file.name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} asset, found ${matches.length}`);
  }
  return matches[0];
}

function releaseAsset(tagName, file, checksums) {
  const sha256 = checksums.get(file.name);
  if (!sha256) throw new Error(`Missing SHA-256 for ${file.name}`);
  return {
    name: file.name,
    bytes: file.size,
    size: `${(file.size / 1024 / 1024).toFixed(2)} MiB`,
    sha256,
    url: `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(file.name)}`,
  };
}

export function buildReleaseManifest({ tagName, files, checksumSource }) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName)) {
    throw new Error(`Invalid release tag: ${tagName}`);
  }
  for (const file of files) {
    if (path.basename(file.name) !== file.name) throw new Error(`Unsafe asset name: ${file.name}`);
  }

  const checksums = parseChecksums(checksumSource);
  const windows = selectAsset(files, /_x64-setup\.exe$/i, 'Windows NSIS');
  const windowsMsi = selectAsset(files, /_x64_en-US\.msi$/i, 'Windows MSI');
  const mac = selectAsset(files, /_aarch64\.dmg$/i, 'macOS ARM64');

  return {
    schemaVersion: 1,
    version: tagName.slice(1),
    tagName,
    releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tagName)}`,
    checksumsUrl: `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tagName)}/SHA256SUMS`,
    assets: {
      windows: releaseAsset(tagName, windows, checksums),
      windowsMsi: releaseAsset(tagName, windowsMsi, checksums),
      mac: releaseAsset(tagName, mac, checksums),
    },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assetsDirectory = argument('--assets');
  const tagName = argument('--tag');
  const output = argument('--output');
  if (!assetsDirectory || !tagName || !output) {
    throw new Error('Usage: render-release-site.mjs --assets <directory> --tag <tag> --output <file>');
  }

  const files = readdirSync(assetsDirectory)
    .filter((name) => /\.(?:exe|msi|dmg)$/i.test(name))
    .map((name) => ({ name, size: statSync(path.join(assetsDirectory, name)).size }));
  const checksumSource = readFileSync(path.join(assetsDirectory, 'SHA256SUMS'), 'utf8');
  const manifest = buildReleaseManifest({ tagName, files, checksumSource });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[render-release-site] wrote ${output} for ${tagName}`);
}
