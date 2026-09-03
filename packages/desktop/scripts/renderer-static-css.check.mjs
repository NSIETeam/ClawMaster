import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = path.join(desktopRoot, 'dist', 'renderer');

test('production renderer embeds the complete CSS before Tauri packages it', async () => {
  const html = await readFile(path.join(rendererRoot, 'index.html'), 'utf8');
  const stylesheet = html.match(/<style[^>]+data-clawmaster-renderer[^>]*>([\s\S]+?)<\/style>/i)?.[1];

  assert.ok(stylesheet, 'dist/renderer/index.html must embed the renderer CSS');
  assert.ok(Buffer.byteLength(stylesheet) > 10_000, 'renderer CSS is unexpectedly small');
  assert.ok(
    Buffer.byteLength(stylesheet) < 370_000,
    `production renderer CSS must be minified: ${Buffer.byteLength(stylesheet)} bytes`,
  );
  assert.doesNotMatch(
    stylesheet,
    /═{4,}/u,
    'production renderer CSS must not retain source-only section comments',
  );
  assert.match(stylesheet, /\.otto-app\s*\{/);
  assert.match(stylesheet, /--otto-bg\s*:/);

  const entryScript = html.match(/<script[^>]+src=["']([^"']+)["'][^>]*>/i)?.[1];
  assert.match(
    entryScript ?? '',
    /^assets\/main\.[a-f0-9]{8}\.js$/,
    'production renderer entry must be content-hashed to avoid stale WebKit caches',
  );
});

test('production renderer emits images instead of parsing base64 inside JavaScript', async () => {
  const assetNames = await readdir(path.join(rendererRoot, 'assets'));
  const scripts = assetNames.filter((name) => name.endsWith('.js'));
  const scriptContents = await Promise.all(
    scripts.map((name) => readFile(path.join(rendererRoot, 'assets', name), 'utf8')),
  );
  const scriptStats = await Promise.all(
    scripts.map((name) => stat(path.join(rendererRoot, 'assets', name))),
  );
  const totalScriptBytes = scriptStats.reduce((total, entry) => total + entry.size, 0);

  assert.equal(
    scriptContents.some((source) => /data:image\/(?:png|jpe?g|gif|svg\+xml);base64,/i.test(source)),
    false,
    'production JavaScript must not embed renderer images as base64',
  );
  assert.ok(
    totalScriptBytes < 1.5 * 1024 * 1024,
    `production renderer JavaScript is too large: ${totalScriptBytes} bytes`,
  );
  assert.ok(
    assetNames.every((name) => !/^otto-pet-atlas\.[a-f0-9]{8}\.png$/u.test(name)),
    'legacy Otto pet atlas must not ship in the lean ClawMaster renderer',
  );
  assert.ok(
    assetNames.some((name) => /^agent-ceo\.[a-f0-9]{8}\.png$/u.test(name)),
    'generated icons must be emitted as content-hashed resources',
  );
  assert.ok(
    assetNames.every((name) => !/^meeting-room-default\.[a-f0-9]{8}\.jpg$/u.test(name)),
    'legacy meeting-room fallback photo must not ship in the lean renderer',
  );
});

test('production renderer excludes the browser-only preview bridge', async () => {
  const assetNames = await readdir(path.join(rendererRoot, 'assets'));
  const scripts = assetNames.filter((name) => name.endsWith('.js'));
  const scriptContents = await Promise.all(
    scripts.map((name) => readFile(path.join(rendererRoot, 'assets', name), 'utf8')),
  );

  assert.equal(
    scriptContents.some((source) => source.includes('0.0.1-browser-preview')),
    false,
    'production renderer must not package browser preview fixtures or its mock host bridge',
  );
});
