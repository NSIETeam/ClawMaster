/** Minimal PCM/WAV helpers, shared by the Host and the panel. No Node built-ins, no dependencies. */
import { SAMPLE_RATE } from './protocol.ts';

/** One mono float sample buffer in [-1,1] plus the rate it was captured at. */
export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Decode a 16-bit PCM WAV file into float samples.
 * Only the shape the panel produces is accepted (PCM format 1, 16-bit, mono, one data chunk), so a
 * malformed or unexpectedly encoded body is rejected instead of being silently misread as audio.
 * @param bytes - The whole WAV file.
 * @returns Mono float samples with the file's own sample rate.
 */
export function decodeWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44) throw new Error('WAV file is too short.');
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') throw new Error('Not a RIFF/WAVE file.');
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: { start: number; bytes: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt chunk is truncated.');
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { start: body, bytes: Math.min(size, bytes.byteLength - body) };
    }
    offset = body + size + (size % 2);
  }
  if (format === undefined) throw new Error('WAV file has no fmt chunk.');
  if (data === undefined) throw new Error('WAV file has no data chunk.');
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) throw new Error('Only 16-bit PCM WAV is supported.');
  if (format.channels !== 1) throw new Error('Only mono WAV is supported.');
  const count = Math.floor(data.bytes / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(data.start + index * 2, true) / 32768;
  }
  return { samples, sampleRate: format.sampleRate };
}

/** The sample rate the panel records and posts at. */
export function isEngineRate(sampleRate: number): boolean {
  return sampleRate === SAMPLE_RATE;
}

/**
 * Encode mono float samples as a 16-bit PCM WAV file.
 * @param pcm - Samples and their rate.
 * @returns The complete WAV file bytes.
 */
export function encodeWav(pcm: Pcm): Uint8Array {
  const { samples, sampleRate } = pcm;
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/**
 * Resample mono float samples by linear interpolation.
 * Speech recognition is insensitive to the small aliasing this introduces at 48 kHz to 16 kHz, and a
 * dependency-free resampler keeps the panel bundle small.
 * @param samples - Source samples.
 * @param fromRate - Source rate in Hz.
 * @param toRate - Target rate in Hz.
 * @returns Resampled mono samples.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    out[index] = (samples[left] ?? 0) * (1 - weight) + (samples[right] ?? 0) * weight;
  }
  return out;
}

/**
 * Root-mean-square level of a sample range, in [0,1].
 * @param samples - Source samples.
 * @param from - First index, inclusive.
 * @param to - Last index, exclusive.
 * @returns The RMS level, or 0 for an empty range.
 */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  if (to <= from) return 0;
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / (to - from));
}

/** Base64 of raw bytes, browser and Node safe. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/** Raw bytes from base64, browser and Node safe. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index] ?? 0);
  return text;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}
