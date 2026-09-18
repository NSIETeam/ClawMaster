/**
 * The model manifest.
 *
 * These checks exist because the failure they prevent is silent: a wrong hash or a wrong byte count
 * means the native engine loads something that is not the model, or refuses it with an unrelated
 * message, and the user sees "the engine is not ready" with no hint that a download was truncated.
 * The manifest is also the only place a URL is allowed to be written down, so the checks pin the
 * source policy that was measured on this network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODELS, defaultDirectory, hostOf, selected } from '../scripts/fetch-models.mjs';

test('every model pins a name, a size, a hash and a role', () => {
  assert.ok(MODELS.length >= 4);
  for (const model of MODELS) {
    assert.match(model.name, /^[a-z0-9][a-z0-9.-]*\.(onnx|txt)$/, model.name);
    assert.ok(Number.isInteger(model.bytes) && model.bytes > 0, `${model.name} bytes`);
    assert.match(model.sha256, /^[0-9a-f]{64}$/, `${model.name} sha256`);
    assert.ok(typeof model.role === 'string' && model.role.length > 10, `${model.name} role`);
  }
});

test('model names are unique', () => {
  const names = MODELS.map(model => model.name);
  assert.equal(new Set(names).size, names.length);
});

test('the files the engine requires are all in the default set', () => {
  const required = MODELS.filter(model => model.optional !== true).map(model => model.name).sort();
  // These names are what src/engine.ts resolves; a rename there without a rename here would leave a
  // user with a verified download that the engine still cannot see.
  assert.deepEqual(required, ['speaker-embedding.onnx', 'whisper-decoder.onnx', 'whisper-encoder.onnx', 'whisper-tokens.txt']);
});

test('every source is https and no source is a bare archive', () => {
  for (const model of MODELS) {
    assert.ok(model.sources.length >= 1, `${model.name} has a source`);
    for (const source of model.sources) {
      assert.match(source, /^https:\/\//, source);
      // An archive source would need extraction, which this script deliberately does not do; a `#`
      // suffix would silently be skipped, so the manifest must not carry one.
      assert.equal(source.includes('#'), false, `${model.name} source must be a plain file: ${source}`);
    }
  }
});

test('the sources a file may use match how big it is on this network', () => {
  for (const model of MODELS) {
    const hosts = model.sources.map(hostOf);
    assert.equal(new Set(hosts).size, hosts.length, `${model.name} lists a host twice`);
    // Measured: hf-mirror answers metadata and small files but redirects large ones to a CDN that is
    // unreachable here, so a large file must have a non-hf-mirror source to fall back on.
    if (model.bytes > 8 * 1024 * 1024) {
      assert.ok(hosts.some(host => host !== 'hf-mirror.com'), `${model.name} needs a non-mirror source`);
    }
  }
});

test('the default directory is the one the component reads', () => {
  const directory = defaultDirectory();
  assert.ok(directory.startsWith('/'), directory);
  assert.match(directory, /\.clawmaster\/components\/voice\/models$/);
});

test('selection defaults to the required set and expands with all', () => {
  const base = selected({ all: false, only: [] });
  assert.equal(base.some(model => model.optional === true), false);
  const everything = selected({ all: true, only: [] });
  assert.equal(everything.length, MODELS.length);
  const one = selected({ all: false, only: ['whisper-tokens.txt'] });
  assert.deepEqual(one.map(model => model.name), ['whisper-tokens.txt']);
  assert.throws(() => selected({ all: false, only: ['nope.onnx'] }), /Unknown model/);
});

test('hostOf never returns a signed query string', () => {
  assert.equal(hostOf('https://modelscope.cn/api/v1/models/x?Policy=secret&Signature=abc'), 'modelscope.cn');
  assert.equal(hostOf('not a url'), 'not a url');
});

test('the model directory can be relocated by the environment', async () => {
  const { resolveModelDirectory, defaultModelDirectory, MODEL_DIRECTORY_ENV } = await import('../src/engine.ts');
  const home = '/Users/example';
  // The profile wins, then the environment, then the default under the home directory.
  assert.equal(resolveModelDirectory('/mnt/models', home, {}), '/mnt/models');
  assert.equal(resolveModelDirectory(undefined, home, { [MODEL_DIRECTORY_ENV]: '/mnt/models' }), '/mnt/models');
  assert.equal(resolveModelDirectory(undefined, home, { [MODEL_DIRECTORY_ENV]: '   ' }), defaultModelDirectory(home));
  assert.equal(resolveModelDirectory(undefined, home, {}), defaultModelDirectory(home));
});
