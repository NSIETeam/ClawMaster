/**
 * WAV and resampling rules.
 * These are the only audio transforms the component performs on its own, so each one is pinned:
 * a wrong byte order or a wrong rate would silently produce plausible-looking garbage transcripts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWav, encodeWav, fromBase64, resample, rms, toBase64 } from '../src/wav.ts';

test('a WAV round-trips through the encoder and the decoder', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const bytes = encodeWav({ samples, sampleRate: 16_000 });
  assert.equal(bytes.byteLength, 44 + samples.length * 2);
  const decoded = decodeWav(bytes);
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.samples.length, samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    assert.ok(Math.abs(decoded.samples[index] - samples[index]) < 1e-4, `sample ${index}`);
  }
});

test('the header names RIFF/WAVE and one mono 16-bit channel', () => {
  const bytes = encodeWav({ samples: new Float32Array(16), sampleRate: 16_000 });
  const ascii = (from, length) => String.fromCharCode(...bytes.subarray(from, from + length));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
});

test('a stereo file is rejected instead of being read as half-speed mono', () => {
  const bytes = encodeWav({ samples: new Float32Array(8), sampleRate: 16_000 });
  new DataView(bytes.buffer).setUint16(22, 2, true);
  assert.throws(() => decodeWav(bytes), /mono/);
});

test('a truncated file is rejected rather than returning short audio', () => {
  assert.throws(() => decodeWav(new Uint8Array(20)), /too short/);
  // Lop off the data chunk by turning its identifier into an unknown one: the file is still a
  // well-formed RIFF container, so only the missing payload can explain the rejection.
  const bytes = encodeWav({ samples: new Float32Array(8), sampleRate: 16_000 });
  bytes.set([0x6a, 0x75, 0x6e, 0x6b], 36);
  assert.throws(() => decodeWav(bytes), /no data chunk/);
});

test('a file with no fmt chunk is rejected', () => {
  const bytes = encodeWav({ samples: new Float32Array(8), sampleRate: 16_000 });
  bytes.set([0x6a, 0x75, 0x6e, 0x6b], 12);
  assert.throws(() => decodeWav(bytes), /no fmt chunk/);
});

test('non-RIFF bytes are rejected', () => {
  const bytes = new Uint8Array(64);
  assert.throws(() => decodeWav(bytes), /Not a RIFF/);
});

test('resampling 48 kHz to 16 kHz keeps duration and shape', () => {
  const source = new Float32Array(48_000);
  for (let index = 0; index < source.length; index += 1) source[index] = Math.sin((2 * Math.PI * 440 * index) / 48_000);
  const out = resample(source, 48_000, 16_000);
  assert.equal(out.length, 16_000, 'one second stays one second');
  assert.ok(Math.abs(rms(out) - rms(source)) < 0.02, 'energy is preserved');
});

test('resampling to the same rate returns the same buffer', () => {
  const source = new Float32Array([1, 2, 3]);
  assert.equal(resample(source, 16_000, 16_000), source);
});

test('rms of silence is zero and of full scale is one', () => {
  assert.equal(rms(new Float32Array(100)), 0);
  assert.ok(Math.abs(rms(new Float32Array(100).fill(1)) - 1) < 1e-6);
  assert.equal(rms(new Float32Array(0)), 0);
});

test('base64 helpers survive bytes above 0x7f', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 200, 255]);
  assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes]);
  assert.ok(toBase64(bytes).length > 0);
});
