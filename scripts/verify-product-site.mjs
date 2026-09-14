#!/usr/bin/env node
/** Check the published HTML against the release manifest before deploying Pages. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'site');
const read = (file) => readFileSync(resolve(directory, file), 'utf8');
const html = read('index.html');
const manifest = JSON.parse(read('release-manifest.json'));
const keys = ['windows', 'mac-arm64', 'mac-x64', 'linux-appimage', 'linux-deb'];
assert.equal(manifest.schemaVersion, 2);
assert.deepEqual(Object.keys(manifest.assets).sort(), [...keys].sort());
assert.equal(manifest.tagName, `desktop-v${manifest.version}`);
assert.equal(manifest.version, `${manifest.programVersion}-release`);
const repository = 'https://github.com/NSIETeam/ClawMaster-Desktop';
const download = `${repository}/releases/download/${manifest.tagName}/`;
assert.equal(manifest.releaseUrl, `${repository}/releases/tag/${manifest.tagName}`);
assert.equal(manifest.checksumsUrl, `${download}SHA256SUMS.txt`);
assert(html.includes(`下载 ${manifest.version}`));
assert(html.includes('开启AI时代的企业协作'));
assert(!/0\.0\.2|安装后无需 Node|原生 Rust\/Tauri|REAL MOUSE RPA/.test(html + read('app.js')));

function element(attribute, key, tag) {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*${attribute}="${key}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
  assert.equal(matches.length, 1, `${attribute}=${key} must occur exactly once`);
  return matches[0];
}
for (const key of keys) {
  const asset = manifest.assets[key];
  assert.match(asset.name, /^[a-zA-Z0-9.-]+$/);
  assert.equal(asset.url, download + asset.name);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
  assert.equal(asset.size, `${(asset.bytes / 1024 / 1024).toFixed(2)} MiB`);
  assert(element('data-release-link', key, 'a')[0].includes(`href="${asset.url}"`));
  assert.equal(element('data-release-sha', key, 'code')[1], asset.sha256);
  assert.equal(element('data-release-size', key, 'dd')[1], asset.size);
  element('data-release-copy', key, 'button');
}
for (const [key, url] of [['notes', manifest.releaseUrl], ['checksums', manifest.checksumsUrl]]) {
  assert(element('data-release-link', key, 'a')[0].includes(`href="${url}"`));
}
const versions = [...html.matchAll(/<dd data-release-version>([^<]+)<\/dd>/g)];
assert.equal(versions.length, 5);
versions.forEach((match) => assert.equal(match[1], manifest.programVersion));
for (const file of ['styles.css', 'app.js', '.nojekyll', 'favicon.svg', 'assets/clawmaster.svg', 'assets/clawmaster-dark.svg', 'assets/share-card.svg', 'assets/watchdog-workspace.png']) {
  assert(existsSync(resolve(directory, file)), `Missing site asset: ${file}`);
}
const guide = read('guide.html');
assert(guide.includes('WatchDog'));
assert(guide.includes('0.2.0-release'));
assert(existsSync(resolve(directory, 'guide.css')));
for (const [name, source] of [['index.html', html], ['guide.html', guide]]) {
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${name}: duplicate IDs`);
  for (const [, attribute, value] of source.matchAll(/\b(href|src)="([^"]+)"/g)) {
    if (value.startsWith('https://')) continue;
    const [file, anchor] = value.split('#');
    const target = file?.endsWith('/') ? `${file}index.html` : file || name;
    assert(existsSync(resolve(directory, target)), `Missing ${attribute}: ${value}`);
    if (anchor) assert(read(target).includes(`id="${anchor}"`), `Missing anchor: ${value}`);
  }
}
console.log(`Product site verified: ${manifest.version}, five installers with matching sizes and SHA-256.`);
