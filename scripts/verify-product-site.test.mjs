import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const site = resolve('site');
const verifier = resolve('scripts/verify-product-site.mjs');

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

test('six matching desktop and Android downloads pass', () => {
  const result = verifyFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /six installers/);
});

for (const [name, mutate, error] of [
  ['missing APK asset', directory => {
    const path = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.assets.android;
    writeFileSync(path, JSON.stringify(manifest));
  }, /android/],
  ['wrong displayed APK checksum', directory => {
    const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
    replace(directory, 'index.html', manifest.assets.android.sha256, '0'.repeat(64));
  }, /AssertionError/],
  ['old Android guide download', directory => replace(directory, 'android.html', 'releases/download/desktop-v0.2.1/', 'releases/download/desktop-v0.2.0-release/'), /Android guide download/],
  ['missing model-test limitation', directory => replace(directory, 'android.html', '记录型模型回复', '真实模型已验证'), /model test limitations/],
  ['missing uninstall warning', directory => replace(directory, 'android.html', '卸载会删除', '卸载会保留'), /uninstall data loss/],
  ['missing Android tutorial navigation', directory => replace(directory, 'tutorials.html', 'href="android.html"', 'href="guide.html"'), /Tutorial center must link to Android/],
  ['invalid publication date', directory => {
    const path = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.publishedAt = null;
    writeFileSync(path, JSON.stringify(manifest));
  }, /Missing publication date/],
]) {
  test(name + ' is rejected', () => {
    const result = verifyFixture(mutate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  });
}
