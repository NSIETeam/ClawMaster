import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyManifest, verifyPublishedReleases } from './verify-product-site.mjs';

const site = resolve('site');
const verifier = resolve('scripts/verify-product-site.mjs');
const manifest = JSON.parse(readFileSync(join(site, 'release-manifest.json'), 'utf8'));

function mutateManifest(directory, mutate) {
  const path = join(directory, 'release-manifest.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, JSON.stringify(value));
}

function publishedRelease(channel) {
  const release = manifest.releases[channel];
  return {
    tag_name: release.tagName, html_url: release.releaseUrl, published_at: release.publishedAt,
    draft: false, prerelease: false,
    assets: [
      { name: 'SHA256SUMS.txt', browser_download_url: release.checksumsUrl },
      ...Object.values(manifest.assets).filter(asset => asset.release === channel).map(asset => ({
        name: asset.name, size: asset.bytes, digest: `sha256:${asset.sha256}`, browser_download_url: asset.url,
      })),
    ],
  };
}

test('platforms may retain independent released versions', () => {
  assert.equal(manifest.releases.desktop.version, '0.2.2');
  assert.equal(manifest.releases.android.version, '0.2.1');
  verifyManifest(manifest);
});

for (const [name, mutate, error] of [
  ['desktop asset assigned to Android release', value => { value.assets.windows.release = 'android'; }, /wrong platform release/],
  ['Android name changed to desktop version', value => { value.assets.android.name = 'clawmaster-0.2.2-android-universal.apk'; }, /filename must match/],
  ['Android download under desktop tag', value => { value.assets.android.url = value.assets.android.url.replace('desktop-v0.2.1', 'desktop-v0.2.2'); }, /download must match/],
  ['Android release metadata under desktop tag', value => { value.releases.android.tagName = 'desktop-v0.2.2'; }, /AssertionError/],
  ['wrong platform filename', value => { value.assets.windows.name = value.assets['mac-arm64'].name; }, /filename must match/],
  ['Intel Mac asset', value => { value.assets['mac-x64'] = { ...value.assets['mac-arm64'] }; }, /mac-x64/],
]) {
  test(name + ' is rejected before checking HTML', () => {
    const value = structuredClone(manifest);
    mutate(value);
    assert.throws(() => verifyManifest(value), error);
  });
}

test('public asset lookup binds each platform to its own release', async () => {
  const urls = [];
  await verifyPublishedReleases(manifest, async url => {
    urls.push(url);
    const channel = url.endsWith('/desktop-v0.2.2') ? 'desktop' : 'android';
    return { ok: true, json: async () => publishedRelease(channel) };
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/NSIETeam/ClawMaster-Desktop/releases/tags/desktop-v0.2.2',
    'https://api.github.com/repos/NSIETeam/ClawMaster-Desktop/releases/tags/desktop-v0.2.1',
  ]);
});

for (const [name, mutate, error] of [
  ['unpublished release', release => { release.draft = true; }, /draft release/],
  ['prerelease', release => { release.prerelease = true; }, /prerelease/],
  ['missing installer', release => { release.assets.splice(1, 1); }, /missing or duplicate published asset/],
  ['wrong published bytes', release => { release.assets[1].size += 1; }, /published byte count/],
  ['missing published digest', release => { delete release.assets[1].digest; }, /published SHA-256/],
  ['wrong published digest', release => { release.assets[1].digest = `sha256:${'0'.repeat(64)}`; }, /published SHA-256/],
  ['mixed release download', release => { release.assets[1].browser_download_url = release.assets[1].browser_download_url.replace('desktop-v0.2.2', 'desktop-v0.2.1'); }, /published URL/],
]) {
  test(name + ' fails public asset verification', async () => {
    await assert.rejects(verifyPublishedReleases(manifest, async () => {
      const release = publishedRelease('desktop');
      mutate(release);
      return { ok: true, json: async () => release };
    }), error);
  });
}

test('a nonexistent release fails public asset verification', async () => {
  await assert.rejects(verifyPublishedReleases(manifest, async () => ({ ok: false, status: 404 })), /lookup failed \(404\)/);
});

function verifyFixture(mutate) {
  const directory = mkdtempSync(join(tmpdir(), 'clawmaster-site-'));
  try {
    cpSync(site, directory, { recursive: true });
    mutate?.(directory);
    const result = spawnSync(process.execPath, [verifier, directory], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Verifier must exit without a terminating signal');
    return result;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function replace(directory, file, before, after) {
  const path = join(directory, file);
  const source = readFileSync(path, 'utf8');
  assert(source.includes(before), `Missing negative-control input: ${before}`);
  writeFileSync(path, source.replace(before, after));
}

test('five static downloads retain the desktop and independent Android versions', () => {
  const result = verifyFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /desktop 0\.2\.2, Android 0\.2\.1; five installers/);
});

for (const [name, mutate, error] of [
  ['missing APK asset', directory => mutateManifest(directory, value => { delete value.assets.android; }), /android/],
  ['wrong displayed APK checksum', directory => {
    const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
    replace(directory, 'index.html', manifest.assets.android.sha256, '0'.repeat(64));
  }, /AssertionError/],
  ['old Android guide download', directory => replace(directory, 'android.html', 'releases/download/desktop-v0.2.1/', 'releases/download/desktop-v0.2.0-release/'), /Android guide download/],
  ['missing model-test limitation', directory => replace(directory, 'android.html', '记录型模型回复', '真实模型已验证'), /model test limitations/],
  ['missing uninstall warning', directory => replace(directory, 'android.html', '卸载会删除', '卸载会保留'), /uninstall data loss/],
  ['missing Android tutorial navigation', directory => replace(directory, 'tutorials.html', 'href="android.html"', 'href="guide.html"'), /Tutorial center must link to Android/],
  ['wrong displayed Android version', directory => replace(directory, 'index.html', '<dd data-release-version="android">0.2.1</dd>', '<dd data-release-version="android">0.2.2</dd>'), /android: displayed version/],
  ['Android checksum link redirected to desktop release', directory => replace(directory, 'index.html', `data-release-link="android-checksums" href="${manifest.releases.android.checksumsUrl}"`, `data-release-link="android-checksums" href="${manifest.releases.desktop.checksumsUrl}"`), /AssertionError/],
  ['missing upgrade tutorial navigation', directory => replace(directory, 'tutorials.html', 'href="updates.html"', 'href="guide.html"'), /Tutorial center must link to upgrade guidance/],
  ['unmarked Intel download', directory => replace(directory, 'index.html', '</body>', `<a href="https://github.com/NSIETeam/ClawMaster-Desktop/releases/download/desktop-v0.2.1/clawmaster-0.2.1-macos-x64.dmg">Intel Mac</a></body>`), /installer link is not a supported manifest download/],
  ['invalid publication date', directory => mutateManifest(directory, value => { value.releases.android.publishedAt = null; }), /Missing publication date/],
]) {
  test(name + ' is rejected', () => {
    const result = verifyFixture(mutate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  });
}
