import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNativeCapabilityPrompt, loadNativeCapabilities } from './nativeCapabilities.js';

const originalManifest = process.env['CLAWMASTER_NATIVE_CAPABILITIES_FILE'];

afterEach(() => {
  if (originalManifest === undefined) delete process.env['CLAWMASTER_NATIVE_CAPABILITIES_FILE'];
  else process.env['CLAWMASTER_NATIVE_CAPABILITIES_FILE'] = originalManifest;
});

describe('native capability manifest', () => {
  it('loads only ready capabilities and creates model-visible rules', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmaster-native-capabilities-'));
    const manifest = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      runtime: 'clawmaster-rust',
      capabilities: [
        { id: 'pdf.merge', provider: 'rust:lopdf', status: 'ready', description: 'native merge' },
        { id: 'voice.transcribe', provider: 'optional', status: 'unavailable', description: 'not installed' },
      ],
    }));
    process.env['CLAWMASTER_NATIVE_CAPABILITIES_FILE'] = manifest;

    expect(loadNativeCapabilities()).toHaveLength(1);
    const prompt = buildNativeCapabilityPrompt();
    expect(prompt).toContain('pdf.merge [rust:lopdf]');
    expect(prompt).toContain('不得建议用户重复安装');
    expect(prompt).not.toContain('voice.transcribe');
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
