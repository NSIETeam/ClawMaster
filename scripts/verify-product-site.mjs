#!/usr/bin/env node
/** Check the published HTML against the release manifest before deploying Pages. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'https://github.com/NSIETeam/ClawMaster-Desktop';
const targets = {
  windows: ['desktop', 'windows-x64-setup.exe'],
  'mac-arm64': ['desktop', 'macos-arm64.dmg'],
  'linux-appimage': ['desktop', 'linux-x64.AppImage'],
  'linux-deb': ['desktop', 'linux-x64.deb'],
  android: ['android', 'android-universal.apk'],
};
const keys = Object.keys(targets);

/** Check platform releases, filenames and download directories without network access. */
export function verifyManifest(manifest) {
  assert.equal(manifest.schemaVersion, 4);
  assert.deepEqual(Object.keys(manifest.releases).sort(), ['android', 'desktop']);
  assert.deepEqual(Object.keys(manifest.assets).sort(), [...keys].sort());
  for (const release of Object.values(manifest.releases)) {
    assert.match(release.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    assert.equal(release.version, release.programVersion);
    assert.equal(release.tagName, `desktop-v${release.version}`);
    assert(typeof release.publishedAt === 'string' && Number.isFinite(Date.parse(release.publishedAt)), 'Missing publication date');
    assert.equal(release.releaseUrl, `${repository}/releases/tag/${release.tagName}`);
    assert.equal(release.checksumsUrl, `${repository}/releases/download/${release.tagName}/SHA256SUMS.txt`);
  }
  for (const [key, [channel, suffix]] of Object.entries(targets)) {
    const asset = manifest.assets[key];
    const release = manifest.releases[channel];
    assert.equal(asset.release, channel, `${key}: wrong platform release`);
    assert.equal(asset.name, `clawmaster-${release.programVersion}-${suffix}`, `${key}: filename must match its platform and release`);
    assert.equal(asset.url, `${repository}/releases/download/${release.tagName}/${asset.name}`, `${key}: download must match its release`);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    assert.equal(asset.size, asset.bytes < 1024 * 1024
      ? `${(asset.bytes / 1024).toFixed(2)} KiB`
      : `${(asset.bytes / 1024 / 1024).toFixed(2)} MiB`);
  }
}

/** Match public GitHub release metadata and every advertised asset; does not download installers. */
export async function verifyPublishedReleases(manifest, fetchRelease = fetch) {
  verifyManifest(manifest);
  for (const [channel, release] of Object.entries(manifest.releases)) {
    const response = await fetchRelease(`https://api.github.com/repos/NSIETeam/ClawMaster-Desktop/releases/tags/${release.tagName}`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000),
    });
    assert(response.ok, `${channel}: GitHub release lookup failed (${response.status})`);
    const published = await response.json();
    assert.equal(published.draft, false, `${channel}: draft release is not public`);
    assert.equal(published.prerelease, false, `${channel}: prerelease is not a stable download`);
    assert.equal(published.tag_name, release.tagName);
    assert.equal(published.html_url, release.releaseUrl);
    assert.equal(published.published_at, release.publishedAt);
    const checksum = published.assets.filter(asset => asset.name === 'SHA256SUMS.txt');
    assert.equal(checksum.length, 1, `${channel}: missing or duplicate published checksums`);
    assert.equal(checksum[0].browser_download_url, release.checksumsUrl);
    for (const [key, asset] of Object.entries(manifest.assets).filter(([, asset]) => asset.release === channel)) {
      const matches = published.assets.filter(candidate => candidate.name === asset.name);
      assert.equal(matches.length, 1, `${key}: missing or duplicate published asset`);
      assert.equal(matches[0].browser_download_url, asset.url, `${key}: published URL differs`);
      assert.equal(matches[0].size, asset.bytes, `${key}: published byte count differs`);
      assert.equal(matches[0].digest, `sha256:${asset.sha256}`, `${key}: published SHA-256 missing or differs`);
    }
  }
}

/** Check complete static downloads and tutorials, including when JavaScript is disabled. */
export function verifyProductSite(directory) {
  const read = (file) => readFileSync(resolve(directory, file), 'utf8');
  const html = read('index.html');
  const manifest = JSON.parse(read('release-manifest.json'));
  verifyManifest(manifest);
  assert(html.includes(`下载 ${manifest.releases.desktop.version}`));
  assert(html.includes('开启AI时代的企业协作'));
  assert(!/0\.0\.2|安装后无需 Node|原生 Rust\/Tauri|REAL MOUSE RPA/.test(html + read('app.js')));

  function element(attribute, key, tag) {
    const matches = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*${attribute}="${key}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
    assert.equal(matches.length, 1, `${attribute}=${key} must occur exactly once`);
    return matches[0];
  }
  for (const key of keys) {
    const asset = manifest.assets[key];
    assert(element('data-release-link', key, 'a')[0].includes(`href="${asset.url}"`));
    assert.equal(element('data-release-sha', key, 'code')[1], asset.sha256);
    assert.equal(element('data-release-size', key, 'dd')[1], asset.size);
    assert.equal(element('data-release-version', key, 'dd')[1], manifest.releases[asset.release].programVersion, `${key}: displayed version differs`);
    element('data-release-copy', key, 'button');
  }
  for (const [key, url] of [
    ['notes', manifest.releases.desktop.releaseUrl], ['checksums', manifest.releases.desktop.checksumsUrl],
    ['android-notes', manifest.releases.android.releaseUrl], ['android-checksums', manifest.releases.android.checksumsUrl],
  ]) {
    assert(element('data-release-link', key, 'a')[0].includes(`href="${url}"`));
  }
  const versions = [...html.matchAll(/<dd\b[^>]*\bdata-release-version(?:="[^"]*")?[^>]*>/g)];
  assert.equal(versions.length, keys.length, 'Only supported platforms have version cards');
  assert(!/data-release-(?:link|sha|size|copy|version)="mac-x64"/.test(html), 'Intel Mac is not a current download target');
  for (const file of ['styles.css', 'app.js', '.nojekyll', 'favicon.svg', 'assets/clawmaster.svg', 'assets/clawmaster-dark.svg', 'assets/share-card.svg', 'assets/watchdog-workspace.png']) {
    assert(existsSync(resolve(directory, file)), `Missing site asset: ${file}`);
  }
  const guide = read('guide.html');
  assert(guide.includes('WatchDog'));
  assert(guide.includes('0.2.0-release'));
  assert(existsSync(resolve(directory, 'guide.css')));
  const scenarioTitles = new Map([
    ['office.html', '你所要的办公工作区，只需要一个ClawMaster'],
    ['development.html', '使用ClawMaster进行开发'],
    ['personal.html', '使用ClawMaster进行个人管理'],
  ]);
  const library = read('tutorials.html');
  assert(html.includes('href="tutorials.html"'), 'Homepage must link to tutorial center');
  for (const [name, title] of scenarioTitles) {
    const source = read(name);
    const heading = source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1];
    assert.equal(heading?.replace(/<[^>]+>/g, '').replace(/\s/g, ''), title);
    assert(source.includes(`https://nsieteam.github.io/ClawMaster/${name}`), `${name}: missing canonical URL`);
    assert(library.includes(`href="${name}"`), `Tutorial center must link to ${name}`);
    assert(html.includes(`href="${name}"`), `Homepage must link to ${name}`);
  }
  assert(library.includes('href="guide.html"'), 'WatchDog tutorial must remain discoverable');
  assert(library.includes('href="android.html"'), 'Tutorial center must link to Android');
  assert(html.includes('href="android.html"'), 'Homepage must link to Android guide');
  assert(library.includes('href="updates.html"'), 'Tutorial center must link to upgrade guidance');
  assert(html.includes('href="updates.html"'), 'Homepage must link to upgrade guidance');
  const updates = read('updates.html');
  assert(updates.includes(manifest.releases.desktop.version), 'Upgrade guide must identify the desktop release');
  assert(/macOS/.test(updates) && /试用/.test(updates), 'Upgrade guide must identify the macOS trial scope');
  assert(/每次|逐次|每一次/.test(updates) && /授权/.test(updates), 'Upgrade guide must explain per-use authorization');
  assert(/模型/.test(updates) && /发送/.test(updates), 'Upgrade guide must explain model message submission');
  assert(/不.{0,12}(自动|持续|后台)监听|非自动监听/.test(updates), 'Upgrade guide must state the listener limitation');
  const android = read('android.html');
  assert(android.includes(`href="${manifest.assets.android.url}"`), 'Android guide download must match the manifest');
  assert(android.includes('Android 8.0'), 'Android guide must state minimum OS');
  assert(android.includes('记录型模型回复'), 'Android guide must state model test limitations');
  assert(android.includes('卸载会删除'), 'Android guide must state uninstall data loss');
  const downloads = new Set(Object.values(manifest.assets).map(asset => asset.url));
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.html'))) {
    const source = read(name);
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate IDs`);
    for (const [, attribute, value] of source.matchAll(/\b(href|src)="([^"]+)"/g)) {
      if (value.startsWith(`${repository}/releases/download/`) && /\.(?:exe|dmg|AppImage|deb|apk)(?:[?#]|$)/.test(value)) {
        assert(downloads.has(value), `${name}: installer link is not a supported manifest download: ${value}`);
      }
      if (value.startsWith('https://')) continue;
      const [file, anchor] = value.split('#');
      const target = file?.endsWith('/') ? `${file}index.html` : file || name;
      assert(existsSync(resolve(directory, target)), `Missing ${attribute}: ${value}`);
      if (anchor) assert(read(target).includes(`id="${anchor}"`), `Missing anchor: ${value}`);
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert(args.filter(arg => arg !== '--online').length <= 1 && args.every(arg => arg === '--online' || !arg.startsWith('--')), 'Usage: verify-product-site.mjs [site-directory] [--online]');
  const manifest = verifyProductSite(resolve(args.find(arg => arg !== '--online') ?? 'site'));
  if (args.includes('--online')) await verifyPublishedReleases(manifest);
  console.log(`Product site verified: desktop ${manifest.releases.desktop.version}, Android ${manifest.releases.android.version}; five installers with matching sizes and SHA-256.${args.includes('--online') ? ' Public GitHub assets verified.' : ''}`);
}
